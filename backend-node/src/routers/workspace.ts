/* Playground notebooks, diagnostics and projects (milestones + mentor thread). */
import { randomBytes } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import { all, asc, type Db, desc, eq, first, get as getRow, insert, ne, remove, save, T, where } from '../db.ts';
import { anyValue, bool, dict, fail, int, list, model, optional, params, str } from '../http.ts';
import { cut, get, type Json, or, toInt, sortBy, truthy } from '../util.ts';
import type { Notebook, Project, ProjectProgress, User } from '../schema.ts';
import { currentUser } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as diagnostics from '../services/diagnostics.ts';
import * as learning from '../services/learning.ts';
import * as runner from '../services/runner.ts';
import { ago, person } from '../views.ts';
import { h } from './common.ts';

const TEMPLATES: Record<string, { title: string; cells: { type: string; src: string }[] }> = {
  'tebak-angka': {
    title: 'Tebak angka (game)',
    cells: [
      { type: 'note', src: 'Komputer memilih angka rahasia. Kita cek tebakan dengan <b>perbandingan</b>.' },
      { type: 'code', src: 'const rahasia = 7;\nlet tebakan = 5;\nconsole.log("Tebakan:", tebakan);\nconsole.log("Benar?", tebakan === rahasia);' },
    ],
  },
};

const newId = () => randomBytes(4).toString('hex');

async function nbView(db: Db, nb: Notebook): Promise<Json> {
  const ch = nb.attached_chapter_id ? await getRow(db, T.chapters, nb.attached_chapter_id) : undefined;
  return { id: nb.id, title: nb.title, cells: nb.cells || [], updated: ago(nb.updated_at), attached: ch ? learning.chapterRef(ch) : null };
}

async function getNb(db: Db, user: User, nbId: number): Promise<Notebook> {
  const nb = await getRow(db, T.notebooks, nbId);
  if (!nb || nb.user_id !== user.id) fail(404, 'Notebook tidak ditemukan.');
  return nb;
}

const NotebookIn = model({ title: optional(str()), template: optional(str()) });
const NotebookUpdate = model({
  title: optional(str({ maxLength: 160 })), cells: optional(list(dict())), attached_chapter_id: optional(int()), detach: bool({ default: false }),
});
const DiagnoseIn = model({ code: str(), error: dict(), scope_code: str({ default: '' }), where: str({ default: 'playground' }) }); // playground | perkuat | pahami
const CodeIn = model({ code: str() });
const ReviewReq = model({ message: str({ default: '' }) });
const MessageIn = model({ body: str({ minLength: 1, maxLength: 2000 }) });
const nbParam = { params: params(['nb_id']) };
const pidParam = { params: params(['pid']) };

// ------------------------------------------------------------------ projects
async function getProject(db: Db, pid: number): Promise<Project> {
  const p = await getRow(db, T.projects, pid);
  if (!p) fail(404, 'Proyek tidak ditemukan.');
  return p;
}

async function unlocked(db: Db, user: User, proj: Project): Promise<boolean> {
  const ch = await first(db, T.chapters, where(eq(T.chapters.path_id, proj.path_id), eq(T.chapters.kind, 'chapter'), eq(T.chapters.number, proj.unlock_after)));
  if (!ch) return true;
  const p = await learning.getProgress(db, user, ch);
  return Boolean(p && p.completed_at);
}

async function projectProgress(db: Db, user: User, proj: Project, create: true): Promise<ProjectProgress>;
async function projectProgress(db: Db, user: User, proj: Project, create: false): Promise<ProjectProgress | undefined>;
async function projectProgress(db: Db, user: User, proj: Project, create: boolean) {
  const pp = await first(db, T.project_progress, where(eq(T.project_progress.user_id, user.id), eq(T.project_progress.project_id, proj.id)));
  if (pp || !create) return pp;
  const starter = proj.milestones.length ? get(proj.milestones[0], 'starter', '') : '';
  return insert(db, T.project_progress, { user_id: user.id, project_id: proj.id, milestone: 0, code: starter, status: 'work' });
}

async function mentorOf(db: Db, user: User): Promise<User | undefined> {
  const klass = user.class_id ? await getRow(db, T.classes, user.class_id) : undefined;
  return klass && klass.mentor_id ? getRow(db, T.users, klass.mentor_id) : undefined;
}

async function projectView(db: Db, user: User, proj: Project, pp: ProjectProgress): Promise<Json> {
  const ms: Json[] = proj.milestones;
  const curIdx = Math.min(pp.milestone, ms.length - 1);
  const cur: Json = ms.length ? ms[curIdx] : {};
  const last = or(pp.last_run, {});
  const resById = new Map<string, Json>(get(last, 'results', []).map((r: Json) => [r.id, r]));
  const tests = get(cur, 'tests', []).map((t: Json) => {
    const r = resById.get(t.id);
    return { id: t.id, name: t.name, state: r ? (r.pass ? 'pass' : 'fail') : 'idle', ms: r ? get(r, 'ms') : null, detail: r ? get(r, 'detail', '') : '' };
  });
  const reqs = get(cur, 'reqs', []).map((r: Json) => {
    const ids: string[] = get(r, 'tests', []);
    return { text: r.text, done: ids.length > 0 && ids.every(t => truthy(get(resById.get(t) ?? {}, 'pass'))) };
  });
  const thread: Json[] = [];
  for (const m of await all(db, T.messages, where(eq(T.messages.learner_id, user.id), eq(T.messages.project_id, proj.id)), asc(T.messages.created_at), asc(T.messages.id)))
    thread.push({ id: m.id, author: person(await getRow(db, T.users, m.author_id)), me: m.author_id === user.id, body: m.body, ago: ago(m.created_at) });
  const comments: Json[] = [];
  let newComments = 0;
  const sub = await first(db, T.submissions, where(eq(T.submissions.user_id, user.id), eq(T.submissions.project_id, proj.id), eq(T.submissions.milestone, curIdx)),
    desc(T.submissions.created_at), asc(T.submissions.id));
  if (sub && pp.status === 'feedback') {
    for (const c of await all(db, T.review_comments, eq(T.review_comments.submission_id, sub.id), asc(T.review_comments.line), asc(T.review_comments.id)))
      comments.push({ line: c.line, body: c.body, author: person(await getRow(db, T.users, c.author_id)) });
    newComments = comments.length;
  }
  const mentor = await mentorOf(db, user);
  const state = (i: number) => (i < pp.milestone || pp.status === 'portfolio' ? 'done' : i === pp.milestone ? 'now' : 'next');
  return {
    id: proj.id, title: proj.title, number: proj.number, after: proj.unlock_after, description: proj.description,
    status: pp.status, milestone: pp.milestone,
    milestones: ms.map((m, i) => ({
      title: m.title, topic: get(m, 'topic', ''), state: state(i),
      meta: i < pp.milestone || pp.status === 'portfolio' ? 'direview' : i === pp.milestone ? 'sekarang' : get(m, 'topic', ''),
    })),
    current: { index: curIdx, title: get(cur, 'title', ''), reqs, tests, filename: get(cur, 'filename', 'main.js') },
    code: pp.code, logs: get(last, 'logs', []), error: get(last, 'error'),
    thread, comments, new_comments: newComments,
    mentor: person(mentor), learner: person(user),
    portfolio: { published: pp.status === 'portfolio', summary: ms.length ? get(ms[ms.length - 1], 'portfolio', {}) : {} },
  };
}

export default function workspace(app: FastifyInstance) {
  app.get('/api/notebooks', h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const rows = await all(db, T.notebooks, eq(T.notebooks.user_id, user.id), desc(T.notebooks.updated_at), asc(T.notebooks.id));
    const pm = await learning.progressMap(db, user.id);
    const attachable: Json[] = [];
    for (const cid of pm.keys()) attachable.push(learning.chapterRef((await getRow(db, T.chapters, cid))!));
    return {
      items: rows.map(n => ({ id: n.id, title: n.title, updated: ago(n.updated_at) })),
      attachable: sortBy(attachable, c => [c.number]), assist_cap: user.assist_cap,
    };
  }));

  app.post('/api/notebooks', { schema: { body: NotebookIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { title: string | null; template: string | null };
    const tpl = TEMPLATES[body.template || ''];
    const cells = (tpl ? tpl.cells : []).map(c => ({ ...c, id: newId() }));
    const nb = await insert(db, T.notebooks, { user_id: user.id, title: cut(or<string | null, string>(body.title, tpl ? tpl.title : 'Notebook tanpa judul') as string, 160), cells });
    await db.commit();
    return nbView(db, nb);
  }));

  app.get('/api/notebooks/:nb_id', { schema: nbParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    return nbView(db, await getNb(db, user, (req.params as { nb_id: number }).nb_id));
  }));

  app.put('/api/notebooks/:nb_id', { schema: { ...nbParam, body: NotebookUpdate } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { title: string | null; cells: Json[] | null; attached_chapter_id: number | null; detach: boolean };
    const nb = await getNb(db, user, (req.params as { nb_id: number }).nb_id);
    const patch: Partial<Notebook> = {};
    if (body.title !== null) patch.title = body.title.trim() || 'Notebook tanpa judul';
    if (body.cells !== null) {
      patch.cells = body.cells.slice(0, 100).filter(c => ['code', 'note'].includes(get(c, 'type'))).map(c => ({
        id: cut(String(or(get(c, 'id'), newId())), 16), type: c.type, src: cut(String(get(c, 'src', '')), 20000),
      }));
    }
    if (body.detach) patch.attached_chapter_id = null;
    else if (body.attached_chapter_id !== null) {
      if (!(await learning.progressMap(db, user.id)).has(body.attached_chapter_id)) fail(409, 'Bab ini belum kamu buka.');
      patch.attached_chapter_id = body.attached_chapter_id;
    }
    await save(db, T.notebooks, nb, { ...patch, updated_at: new Date() });
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return nbView(db, nb);
  }));

  app.delete('/api/notebooks/:nb_id', { schema: nbParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    await remove(db, T.notebooks, (await getNb(db, user, (req.params as { nb_id: number }).nb_id)).id);
    await db.commit();
    return { ok: true };
  }));

  app.post('/api/diagnose', { schema: { body: DiagnoseIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { code: string; error: Json; scope_code: string; where: string };
    const cap = ['playground', 'perkuat'].includes(body.where) ? user.assist_cap : 6;
    return diagnostics.diagnose(body.code, body.error, body.scope_code, cap);
  }));

  // ------------------------------------------------------------------ projects
  app.get('/api/projects', h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const out: Json[] = [];
    for (const proj of await all(db, T.projects, undefined, asc(T.projects.number), asc(T.projects.id))) {
      const pp = await projectProgress(db, user, proj, false);
      out.push({
        id: proj.id, title: proj.title, number: proj.number, unlocked: await unlocked(db, user, proj), after: proj.unlock_after,
        status: pp ? pp.status : null, milestone: pp ? pp.milestone : 0, milestones: proj.milestones.length,
      });
    }
    return out;
  }));

  app.get('/api/projects/:pid', { schema: pidParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const proj = await getProject(db, (req.params as { pid: number }).pid);
    if (user.role === 'learner' && !(await unlocked(db, user, proj)))
      fail(409, { code: 'locked', message: `Proyek ini terbuka setelah Bab ${proj.unlock_after}.`, redirect: '/peta' });
    const pp = await projectProgress(db, user, proj, true);
    // opening the thread marks mentor messages and a pending review as read
    await db.q.update(T.messages).set({ read: true }).where(where(eq(T.messages.learner_id, user.id), eq(T.messages.project_id, proj.id), ne(T.messages.author_id, user.id), eq(T.messages.read, false)));
    await db.commit();
    return projectView(db, user, proj, pp);
  }));

  app.put('/api/projects/:pid/code', { schema: { ...pidParam, body: CodeIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const proj = await getProject(db, (req.params as { pid: number }).pid);
    const pp = await projectProgress(db, user, proj, true);
    if (['waiting', 'portfolio'].includes(pp.status)) fail(409, 'Kode terkunci selama menunggu review.');
    await save(db, T.project_progress, pp, { code: cut((req.body as { code: string }).code, runner.MAX_CODE_CHARS), updated_at: new Date() });
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return { saved: true };
  }));

  app.post('/api/projects/:pid/run', { schema: { ...pidParam, body: CodeIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const code = (req.body as { code: string }).code;
    const proj = await getProject(db, (req.params as { pid: number }).pid);
    const pp = await projectProgress(db, user, proj, true);
    const cur: Json = proj.milestones[Math.min(pp.milestone, proj.milestones.length - 1)];
    const res = await runner.run(code, get(cur, 'tests', []));
    const patch: Partial<ProjectProgress> = { last_run: { results: res.results, logs: res.logs, error: res.error }, updated_at: new Date() };
    if (!['waiting', 'portfolio'].includes(pp.status)) patch.code = cut(code, runner.MAX_CODE_CHARS);
    await save(db, T.project_progress, pp, patch);
    await db.commit();
    return projectView(db, user, proj, pp);
  }));

  app.post('/api/projects/:pid/review', { schema: { ...pidParam, body: ReviewReq } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const message = (req.body as { message: string }).message;
    const proj = await getProject(db, (req.params as { pid: number }).pid);
    const pp = await projectProgress(db, user, proj, true);
    if (['waiting', 'portfolio'].includes(pp.status)) fail(409, 'Review sudah diminta.');
    const cur: Json = proj.milestones[pp.milestone];
    const res = await runner.run(pp.code, get(cur, 'tests', []));
    const passed = res.results.filter((r: Json) => r.pass).length;
    const prev = await first(db, T.submissions, where(eq(T.submissions.user_id, user.id), eq(T.submissions.project_id, proj.id), eq(T.submissions.milestone, pp.milestone)),
      desc(T.submissions.created_at), asc(T.submissions.id));
    const sub = await insert(db, T.submissions, {
      user_id: user.id, kind: 'milestone', project_id: proj.id, milestone: pp.milestone,
      title: `Proyek · ${proj.title} · milestone ${pp.milestone + 1}`, filename: get(cur, 'filename', 'main.js'),
      code: pp.code, tests_passed: passed, tests_total: res.results.length, attempt_no: prev ? prev.attempt_no + 1 : 1,
      error_line: get(or(get(res, 'error'), {}), 'line', null),
    });
    await save(db, T.project_progress, pp, { status: 'waiting', last_run: { results: res.results, logs: res.logs, error: res.error } });
    if (message.trim())
      await insert(db, T.messages, { learner_id: user.id, author_id: user.id, project_id: proj.id, body: cut(message.trim(), 2000), context: `Proyek ${proj.title}`, read: true });
    const mentor = await mentorOf(db, user);
    if (mentor) await learning.notify(db, mentor.id, 'review', `${user.name} minta review`, sub.title, '/mentor/review');
    await db.commit();
    return projectView(db, user, proj, pp);
  }));

  app.post('/api/projects/:pid/messages', { schema: { ...pidParam, body: MessageIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const text = (req.body as { body: string }).body.trim();
    const proj = await getProject(db, (req.params as { pid: number }).pid);
    const pp = await projectProgress(db, user, proj, true);
    await insert(db, T.messages, { learner_id: user.id, author_id: user.id, project_id: proj.id, body: text, context: `Proyek ${proj.title}`, read: true });
    const mentor = await mentorOf(db, user);
    if (mentor) await learning.notify(db, mentor.id, 'message', `Pesan dari ${user.name}`, cut(text, 120), `/mentor/siswa/${user.id}`);
    await db.commit();
    return projectView(db, user, proj, pp);
  }));
}
