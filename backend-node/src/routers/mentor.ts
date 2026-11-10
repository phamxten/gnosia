/* Mentor: class overview with attention signals, student detail, review queue. */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { all, asc, type Db, desc, eq, first, get as getRow, insert, isIn, remove, save, sql, T, where } from '../db.ts';
import { fail, int, model, optional, params, str } from '../http.ts';
import { first as firstWord, get, type Json, mostCommon, or, pyRound, sortBy, truthy } from '../py.ts';
import type { Chapter, Klass, Submission, User } from '../schema.ts';
import { requireRole } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as content_svc from '../services/content.ts';
import * as learning from '../services/learning.ts';
import * as signals from '../services/signals.ts';
import * as unlock from '../services/unlock.ts';
import { ago, person } from '../views.ts';
import { h } from './common.ts';
import { phaseMeta } from './learner.ts';

const staff = (req: FastifyRequest, db: Db) => requireRole(req, db, 'mentor', 'admin');
const DAY_MS = 86_400_000;

async function classesOf(db: Db, me: User): Promise<Klass[]> {
  return all(db, T.classes, me.role === 'mentor' ? eq(T.classes.mentor_id, me.id) : undefined, asc(T.classes.id));
}

async function klassOf(db: Db, me: User, classId: number | null): Promise<Klass> {
  const cls = await classesOf(db, me);
  if (!cls.length) fail(404, 'Kamu belum punya kelas.');
  if (classId === null) return cls[0];
  const k = cls.find(c => c.id === classId);
  if (!k) fail(403, 'Kelas ini bukan milikmu.');
  return k;
}

const learnersOf = (db: Db, k: Klass) => all(db, T.users, where(eq(T.users.class_id, k.id), eq(T.users.role, 'learner')), asc(T.users.name), asc(T.users.id));

async function studentOf(db: Db, me: User, uid: number): Promise<User> {
  const u = await getRow(db, T.users, uid);
  if (!u || u.role !== 'learner') fail(404, 'Siswa tidak ditemukan.');
  if (me.role === 'mentor' && !(await classesOf(db, me)).some(k => k.id === u.class_id)) fail(403, 'Siswa ini bukan di kelasmu.');
  return u;
}

/** Where a learner is now: chapter, phase and a short progress label. */
async function position(db: Db, u: User): Promise<Json> {
  const klass = u.class_id ? await getRow(db, T.classes, u.class_id) : undefined;
  const path = klass && klass.path_id ? await getRow(db, T.paths, klass.path_id) : await first(db, T.paths);
  if (!path) throw new TypeError("'NoneType' object has no attribute 'id'");
  const chapters = await learning.pathChapters(db, path.id);
  const pm = await learning.progressMap(db, u.id);
  const learn = chapters.filter(c => c.kind === 'chapter');
  const cur = await learning.currentChapter(db, u, chapters, pm);
  if (!cur) {
    const done = learn.filter(c => pm.get(c.id)?.completed_at);
    const last = done.length ? done[done.length - 1] : null;
    return {
      chapter: last ? learning.chapterRef(last) : null, phase: 'uji', label: last ? 'selesai · bab berikutnya segera' : 'belum mulai',
      ring: last ? [1, 1, 1, 1] : [0, 0, 0, 0], number: last ? last.number : 0, total: learn.length, path_id: path.id,
    };
  }
  const prog = pm.get(cur.id);
  const phases = prog ? prog.phases : unlock.initialPhases();
  const ph = unlock.currentPhase(phases);
  const content = or(await content_svc.published(db, cur, prog ? prog.version : null), {});
  const meta = (await phaseMeta(db, u, cur, prog, content)).find(m => m.id === ph)!;
  const short: string = meta.short.replace(' soal', '');
  let label = short.includes('/') ? `${unlock.PHASE_LABEL[ph]} ${short}` : unlock.PHASE_LABEL[ph];
  if (ph === 'kuis') {
    const fails = await all(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, u.id), eq(T.quiz_rounds.chapter_id, cur.id), eq(T.quiz_rounds.kind, 'gate'),
      eq(T.quiz_rounds.finished, true), eq(T.quiz_rounds.passed, false)));
    if (fails.length) label = `Kuis · gagal ${fails.length}×`;
  }
  if (ph === 'uji') {
    const pend = await first(db, T.submissions, where(eq(T.submissions.user_id, u.id), eq(T.submissions.chapter_id, cur.id), eq(T.submissions.status, 'pending')));
    label = pend ? 'Uji · challenge' : 'Uji';
  }
  if (ph === 'pahami' && short.includes('scene')) label = `Pahami ${short.replace('scene ', '')}`;
  return { chapter: learning.chapterRef(cur), phase: ph, label, ring: unlock.ringValues(phases), number: cur.number, total: learn.length, path_id: path.id };
}

async function avgTier(db: Db, u: User): Promise<number> {
  const rows = await db.q.select({ t: T.concept_mastery.tier }).from(T.concept_mastery).where(where(eq(T.concept_mastery.user_id, u.id), sql`${T.concept_mastery.tier} > 0`));
  return rows.length ? pyRound(rows.reduce((a, r) => a + r.t, 0) / rows.length) : 0;
}

async function weak(db: Db, u: User): Promise<boolean> {
  return Boolean(await first(db, T.concept_mastery, where(eq(T.concept_mastery.user_id, u.id), eq(T.concept_mastery.weak, true))));
}

async function badge(sigs: Json[], u: User, db: Db): Promise<Json> {
  const kinds = new Map<string, Json>(sigs.map(s => [s.kind, s]));
  if (kinds.has('repeated')) return { text: `salah ${kinds.get('repeated')!.count}×`, tone: 'danger' };
  if (kinds.has('gate')) return { text: 'gerbang', tone: 'warning' };
  if (kinds.has('review')) return { text: 'minta review', tone: 'accent' };
  if (kinds.has('hints')) return { text: 'buru-buru petunjuk', tone: 'warning' };
  if (kinds.has('stalled')) return { text: 'tidak aktif', tone: '' };
  const st = await activity.streak(db, u);
  if (st >= 3) return { text: `streak ${st}`, tone: 'success' };
  return { text: '–', tone: '' };
}

function weekNo(k: Klass): number {
  if (!k.started_on) return 1;
  return Math.max(1, Math.floor(activity.daysBetween(activity.localToday(), k.started_on) / 7) + 1);
}

async function hardestItem(db: Db, ids: number[], ch: Chapter, phase: string): Promise<string | null> {
  if (!['perkuat', 'kuis'].includes(phase)) return null;
  const content = or(await content_svc.published(db, ch), {});
  const tally = new Map<string, [number, number]>();
  for (const a of await all(db, T.attempts, where(isIn(T.attempts.user_id, ids), eq(T.attempts.chapter_id, ch.id), eq(T.attempts.phase, phase), eq(T.attempts.attempt_no, 1)))) {
    const t = tally.get(a.item_id) ?? [0, 0];
    tally.set(a.item_id, t);
    t[1] += 1;
    t[0] += a.correct ? 0 : 1;
  }
  if (!tally.size) return null;
  let best: [string, [number, number]] | null = null;
  for (const e of tally) if (!best || e[1][0] / e[1][1] > best[1][0] / best[1][1]) best = e;
  const [iid, [w, n]] = best!;
  const pool: Json[] = phase === 'perkuat' ? get(get(content, 'perkuat', {}), 'items', []) : get(get(content, 'kuis', {}), 'bank', []);
  const item = or(content_svc.find(pool, iid), {});
  const name = or(get(item, 'label'), signals.plain(or(get(item, 'title'), or(get(item, 't'), iid))));
  return `Soal “${name}” paling sering salah (${pyRound((100 * w) / n)}%).`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
function joined(u: User): string {
  const d = activity.localDay(u.created_at);
  return `${Number(d.slice(8))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

function when(dt: Date): string {
  const days = activity.daysBetween(activity.localToday(), activity.localDay(dt));
  if (days === 0) return `hari ini ${activity.localHM(dt)}`;
  if (days === 1) return 'kemarin';
  return `${days} hari lalu`;
}

async function timeline(db: Db, u: User, limit = 12): Promise<Json[]> {
  const events: [Date, Json][] = [];
  const byItem = new Map<string, Json[]>();
  const recent = await db.q.select().from(T.attempts).where(eq(T.attempts.user_id, u.id)).orderBy(desc(T.attempts.created_at), asc(T.attempts.id)).limit(300);
  for (const a of recent) {
    const k = JSON.stringify([a.chapter_id, a.phase, a.phase === 'perkuat' ? a.item_id : '*']);
    byItem.set(k, [...(byItem.get(k) ?? []), a]);
  }
  for (const [k, atts] of byItem) {
    const [cid, phase, iid] = JSON.parse(k) as [number, string, string];
    const ch = (await getRow(db, T.chapters, cid))!;
    const latest = new Date(Math.max(...atts.map(a => a.created_at.getTime())));
    if (phase === 'perkuat') {
      const wrong = atts.filter(a => !a.correct).length;
      if (wrong >= 2) {
        const content = or(await content_svc.published(db, ch), {});
        const order = get(get(content, 'perkuat', {}), 'items', []).filter((i: Json) => !truthy(get(i, 'adaptive'))).map((i: Json) => i.id);
        events.push([latest, { phase: 'perkuat', title: `Perkuat · ${ch.title}`, meta: `soal ${order.includes(iid) ? order.indexOf(iid) + 1 : '?'} salah ${wrong}×` }]);
      }
    } else if (phase === 'challenge') {
      let best = atts[0];
      for (const a of atts) if (get(or(a.answer, {}), 'passed', 0) > get(or(best.answer, {}), 'passed', 0)) best = a;
      events.push([latest, { phase: 'uji', title: `Uji · ${ch.title}`, meta: `challenge ${get(or(best.answer, {}), 'passed', 0)}/${get(or(best.answer, {}), 'total', 0)}` }]);
    }
  }
  for (const r of await all(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, u.id), eq(T.quiz_rounds.finished, true), sql`${T.quiz_rounds.chapter_id} is not null`))) {
    const ch = (await getRow(db, T.chapters, r.chapter_id))!;
    events.push([r.created_at, { phase: 'kuis', title: `Kuis · ${ch.title}`, meta: `${r.pct}% · ${r.passed ? 'lulus' : 'belum lulus'}` }]);
  }
  for (const p of await all(db, T.chapter_progress, eq(T.chapter_progress.user_id, u.id))) {
    const ch = (await getRow(db, T.chapters, p.chapter_id))!;
    if (p.phases.pahami.state === 'done') {
      const content = or(await content_svc.published(db, ch, p.version), {});
      const n = get(get(content, 'pahami', {}), 'scenes', []).length;
      events.push([new Date(p.started_at.getTime() + 60_000), { phase: 'pahami', title: `Pahami · ${ch.title}`, meta: `selesai ${n} scene` }]);
    }
  }
  for (const s of await all(db, T.submissions, eq(T.submissions.user_id, u.id)))
    events.push([s.created_at, { phase: 'uji', title: s.title, meta: `${s.tests_passed}/${s.tests_total} · minta review` }]);
  events.sort((a, b) => b[0].getTime() - a[0].getTime());
  return events.slice(0, limit).map(([at, ev]) => ({ ...ev, when: when(at) }));
}

async function getSub(db: Db, me: User, sid: number): Promise<Submission> {
  const s = await getRow(db, T.submissions, sid);
  if (!s) fail(404, 'Kiriman tidak ditemukan.');
  await studentOf(db, me, s.user_id);
  return s;
}

const learnerLink = (s: Submission) => (s.project_id ? `/proyek/${s.project_id}` : `/bab/${s.chapter_id}`);
const stripAt = (s: Json) => Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'at'));

const OverviewQuery = model({ class_id: optional(int()) });
const CapIn = model({ assist_cap: int({ minimum: 0, maximum: 6 }) });
const AssignIn = model({ chapter_id: optional(int()), kind: str({ default: 'mini' }), concept: optional(str()), note: str({ default: '' }) }); // kind: mini | scene
const TextIn = model({ body: str({ default: '', maxLength: 2000 }) });
const CommentIn = model({ line: int({ minimum: 1 }), body: str({ minLength: 1, maxLength: 2000 }) });
const DecisionIn = model({ decision: str(), summary: str({ default: '' }) }); // approve | changes
const uidParam = { params: params(['uid']) };
const sidParam = { params: params(['sid']) };

export default function mentor(app: FastifyInstance) {
  app.get('/api/mentor/classes', h(async (req, _r, db) => {
    const me = await staff(req, db);
    return (await classesOf(db, me)).map(k => ({ id: k.id, name: k.name }));
  }));

  app.get('/api/mentor/overview', { schema: { querystring: OverviewQuery } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const k = await klassOf(db, me, (req.query as { class_id: number | null }).class_id);
    const learners = await learnersOf(db, k);
    const ids = learners.map(u => u.id);
    const path = k.path_id ? await getRow(db, T.paths, k.path_id) : await first(db, T.paths);
    const cache: signals.Cache = new Map();
    const allSignals: Json[] = [];
    const roster: Json[] = [];
    const positions = new Map<number, Json>();
    const weekAgo = Date.now() - 7 * DAY_MS;
    let active = 0;
    for (const u of learners) {
      const sigs = await signals.learnerSignals(db, u, cache);
      for (const s of sigs) s.learner = person(u);
      allSignals.push(...sigs);
      const pos = await position(db, u);
      positions.set(u.id, pos);
      if (u.last_active_at && u.last_active_at.getTime() >= weekAgo) active += 1;
      roster.push({
        learner: person(u), chapter: pos.chapter ? `${pos.number} · ${pos.chapter.title}` : '–', phase: pos.phase, phase_label: pos.label,
        tier: await avgTier(db, u), weak: await weak(db, u), activity: ago(u.last_active_at), badge: await badge(sigs, u, db),
        flags: [...new Set(sigs.map(s => s.kind))].sort(),
      });
    }
    const ranked = signals.rank(allSignals.filter(s => s.kind !== 'review'));
    const reviews = allSignals.filter(s => s.kind === 'review');
    const attention = ranked.slice(0, 6).map(s => ({ ...stripAt(s), ago: ago(s.at) }));
    // funnel for the chapter most of the class is on
    const focus = new Map<number, number>();
    for (const p of positions.values()) if (p.chapter) focus.set(p.chapter.id, (focus.get(p.chapter.id) ?? 0) + 1);
    const focusId = focus.size ? mostCommon(focus)! : null;
    const funnel = focusId ? await signals.phaseFunnel(db, ids, focusId) : null;
    const focusCh = focusId ? await getRow(db, T.chapters, focusId) : undefined;
    let pileText: string | null = null;
    if (funnel && funnel.pile) {
      const ph = funnel.pile.phase;
      const hard = focusCh ? await hardestItem(db, ids, focusCh, ph) : null;
      pileText = `<b>Penumpukan di ${unlock.PHASE_LABEL[ph]}.</b> ${funnel.pile.count} siswa ada di sini, rata-rata ${String(funnel.pile.avg_days).replace('.', ',')} hari.` + (hard ? ` ${hard}` : '');
    }
    return {
      mentor: person(me), class: { id: k.id, name: k.name }, classes: (await classesOf(db, me)).map(c => ({ id: c.id, name: c.name })),
      path: { title: path ? path.title : '' }, week: weekNo(k),
      kpis: {
        active, total: learners.length, attention: new Set(ranked.map(s => s.learner.id)).size,
        stalled: allSignals.filter(s => s.kind === 'stalled').length, review: reviews.length,
      },
      attention,
      funnel: { chapter: focusCh ? learning.chapterRef(focusCh) : null, ...(funnel ?? {}), pile_text: pileText },
      hardest: path ? await signals.hardestConcepts(db, ids, path.id) : [],
      roster,
    };
  }));

  app.get('/api/mentor/students/:uid', { schema: uidParam }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const u = await studentOf(db, me, (req.params as { uid: number }).uid);
    const klass = u.class_id ? await getRow(db, T.classes, u.class_id) : undefined;
    const sigs = await signals.learnerSignals(db, u);
    const pos = await position(db, u);
    const allowWrong = get(u.prefs || {}, 'mentor_sees_wrong', true);
    const patterns = truthy(allowWrong) ? await signals.wrongPatterns(db, u) : [];
    const subs = await db.q.select().from(T.submissions).where(eq(T.submissions.user_id, u.id)).orderBy(desc(T.submissions.created_at), asc(T.submissions.id)).limit(10);
    const weakRows = await db.q.select({ m: T.concept_mastery, c: T.concepts }).from(T.concept_mastery)
      .innerJoin(T.concepts, eq(T.concepts.id, T.concept_mastery.concept_id)).where(eq(T.concept_mastery.user_id, u.id))
      .orderBy(desc(T.concept_mastery.weak), asc(T.concept_mastery.tier), asc(T.concept_mastery.id));
    const rep = sigs.find(s => s.kind === 'repeated');
    return {
      learner: { ...person(u)!, class: klass ? klass.name : '', joined: joined(u), assist_cap: u.assist_cap, email: u.email, allow_wrong: allowWrong },
      position: pos,
      badge: rep ? { text: `salah ${rep.count}× di soal yang sama`, tone: 'danger' } : await badge(sigs, u, db),
      mastery_avg: await learning.overallMasteryPct(db, u, pos.path_id || 1),
      signals: signals.rank(sigs).map(s => ({ ...stripAt(s), ago: ago(s.at) })),
      patterns,
      submissions: subs.map(s => ({ id: s.id, title: s.title, status: s.status, tests: `${s.tests_passed}/${s.tests_total}`, attempt: s.attempt_no, ago: ago(s.created_at) })),
      timeline: await timeline(db, u),
      concepts: weakRows.slice(0, 6).map(({ m, c }) => ({ key: c.key, name: c.name, tier: m.tier, weak: m.weak })),
    };
  }));

  app.patch('/api/mentor/students/:uid', { schema: { ...uidParam, body: CapIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const u = await studentOf(db, me, (req.params as { uid: number }).uid);
    const cap = (req.body as { assist_cap: number }).assist_cap;
    await save(db, T.users, u, { assist_cap: cap });
    await learning.notify(db, u.id, 'cap', 'Pengaturan petunjuk diubah mentor', `Petunjuk dibatasi sampai L${cap}.`, '');
    await db.commit();
    return { assist_cap: u.assist_cap };
  }));

  app.post('/api/mentor/students/:uid/assign', { schema: { ...uidParam, body: AssignIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const body = req.body as { chapter_id: number | null; kind: string; concept: string | null; note: string };
    const u = await studentOf(db, me, (req.params as { uid: number }).uid);
    let ch = body.chapter_id ? await getRow(db, T.chapters, body.chapter_id) : undefined;
    if (!ch) {
      const pos = await position(db, u);
      ch = pos.chapter ? await getRow(db, T.chapters, pos.chapter.id) : undefined;
    }
    if (!ch) fail(404, 'Bab tidak ditemukan.');
    let title: string, link: string;
    if (body.kind === 'scene') {
      title = `Ulas scene Pahami · ${ch.title} + 3 soal`;
      link = `/bab/${ch.id}/pahami` + (body.concept ? `?konsep=${body.concept}` : '');
    } else {
      title = `Perkuat mini · ${ch.title} · 3 soal`;
      link = `/bab/${ch.id}/perkuat?latih=${body.concept || ''}`;
    }
    await insert(db, T.assignments, { mentor_id: me.id, learner_id: u.id, chapter_id: ch.id, title, link });
    await learning.notify(db, u.id, 'assignment', `Tugas dari ${firstWord(me.name)}`, title, link);
    const text = body.note.trim() || `Aku tugaskan ${title}. Kerjakan pelan-pelan, ya.`;
    await insert(db, T.messages, { learner_id: u.id, author_id: me.id, body: text, context: title });
    await db.commit();
    return { ok: true, title };
  }));

  app.post('/api/mentor/students/:uid/remind', { schema: { ...uidParam, body: TextIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const u = await studentOf(db, me, (req.params as { uid: number }).uid);
    const text = (req.body as { body: string }).body.trim() || `Halo ${firstWord(u.name)}, yuk lanjut belajar hari ini. Sedikit saja sudah bagus.`;
    await learning.notify(db, u.id, 'reminder', `Pengingat dari ${firstWord(me.name)}`, text, '/beranda');
    await insert(db, T.messages, { learner_id: u.id, author_id: me.id, body: text, context: 'Pengingat' });
    await db.commit();
    return { ok: true };
  }));

  app.post('/api/mentor/students/:uid/messages', { schema: { ...uidParam, body: TextIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const u = await studentOf(db, me, (req.params as { uid: number }).uid);
    const text = (req.body as { body: string }).body.trim();
    if (!text) fail(422, 'Pesan tidak boleh kosong.');
    await insert(db, T.messages, { learner_id: u.id, author_id: me.id, body: text, context: 'Pesan mentor' });
    await learning.notify(db, u.id, 'message', `Pesan dari ${firstWord(me.name)}`, text.slice(0, 120), '/progres#feedback');
    await db.commit();
    return { ok: true };
  }));

  // ------------------------------------------------------------------ reviews
  app.get('/api/mentor/review', { schema: { querystring: OverviewQuery } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const classId = (req.query as { class_id: number | null }).class_id;
    const ids: number[] = [];
    for (const k of classId ? [await klassOf(db, me, classId)] : await classesOf(db, me)) for (const u of await learnersOf(db, k)) ids.push(u.id);
    const rows = await db.q.select().from(T.submissions).where(isIn(T.submissions.user_id, ids))
      .orderBy(sql`${T.submissions.status} <> 'pending'`, desc(T.submissions.created_at), asc(T.submissions.id)).limit(40);
    const items: Json[] = [];
    for (const s of rows)
      items.push({ id: s.id, learner: person(await getRow(db, T.users, s.user_id)), title: s.title, status: s.status, tests: `${s.tests_passed}/${s.tests_total}`, attempt: s.attempt_no, ago: ago(s.created_at) });
    return { items };
  }));

  app.get('/api/mentor/submissions/:sid', { schema: sidParam }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const s = await getSub(db, me, (req.params as { sid: number }).sid);
    const comments: Json[] = [];
    for (const c of await all(db, T.review_comments, eq(T.review_comments.submission_id, s.id), asc(T.review_comments.line), asc(T.review_comments.id)))
      comments.push({ id: c.id, line: c.line, body: c.body, author: person(await getRow(db, T.users, c.author_id)) });
    return {
      id: s.id, learner: person(await getRow(db, T.users, s.user_id)), title: s.title, filename: s.filename, kind: s.kind,
      code: s.code, attempt: s.attempt_no, tests: { passed: s.tests_passed, total: s.tests_total },
      error_line: s.error_line, status: s.status, summary: s.summary, comments, ago: ago(s.created_at),
    };
  }));

  app.post('/api/mentor/submissions/:sid/comments', { schema: { ...sidParam, body: CommentIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const body = req.body as { line: number; body: string };
    const s = await getSub(db, me, (req.params as { sid: number }).sid);
    const c = await insert(db, T.review_comments, { submission_id: s.id, author_id: me.id, line: body.line, body: body.body.trim() });
    await db.commit();
    return { id: c.id, line: c.line, body: c.body, author: person(me) };
  }));

  app.delete('/api/mentor/submissions/:sid/comments/:cid', { schema: { params: params(['sid', 'cid']) } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const { sid, cid } = req.params as { sid: number; cid: number };
    await getSub(db, me, sid);
    const c = await getRow(db, T.review_comments, cid);
    if (c && c.submission_id === sid && (c.author_id === me.id || me.role === 'admin')) {
      await remove(db, T.review_comments, c.id);
      await db.commit();
    }
    return { ok: true };
  }));

  app.post('/api/mentor/submissions/:sid/decision', { schema: { ...sidParam, body: DecisionIn } }, h(async (req, _r, db) => {
    const me = await staff(req, db);
    const body = req.body as { decision: string; summary: string };
    const s = await getSub(db, me, (req.params as { sid: number }).sid);
    const learner = (await getRow(db, T.users, s.user_id))!;
    await save(db, T.submissions, s, { summary: body.summary.trim(), reviewed_by: me.id, reviewed_at: new Date(), seen_by_learner: false });
    const nComments = (await all(db, T.review_comments, eq(T.review_comments.submission_id, s.id))).length;
    let xp = 0;
    const ppOf = () => first(db, T.project_progress, where(eq(T.project_progress.user_id, learner.id), eq(T.project_progress.project_id, s.project_id!)));
    if (body.decision === 'approve') {
      await save(db, T.submissions, s, { status: 'approved' });
      if (s.kind === 'challenge') xp = await activity.addXp(db, learner, 30, 'Challenge disetujui mentor');
      if (s.kind === 'milestone' && s.project_id !== null) {
        const proj = (await getRow(db, T.projects, s.project_id))!;
        const pp = await ppOf();
        if (pp && pp.milestone === s.milestone) {
          if (pp.milestone + 1 >= proj.milestones.length) await save(db, T.project_progress, pp, { status: 'portfolio', published_at: new Date() });
          else {
            const next = pp.milestone + 1;
            const starter = get(proj.milestones[next], 'starter');
            await save(db, T.project_progress, pp, {
              milestone: next, status: 'work', code: truthy(starter) ? `${pp.code.trimEnd()}\n\n${starter}` : pp.code, last_run: null,
            });
          }
        }
      }
      await learning.notify(db, learner.id, 'review', s.kind === 'challenge' ? 'Challenge disetujui' : 'Milestone disetujui', s.title, learnerLink(s));
    } else {
      await save(db, T.submissions, s, { status: 'changes' });
      if (s.kind === 'milestone' && s.project_id !== null) {
        const pp = await ppOf();
        if (pp) await save(db, T.project_progress, pp, { status: 'feedback' });
      }
      await learning.notify(db, learner.id, 'review', nComments ? `${nComments} komentar baru` : 'Mentor minta perbaikan', s.title, learnerLink(s));
    }
    if (s.summary)
      await insert(db, T.messages, { learner_id: learner.id, author_id: me.id, project_id: s.project_id, body: s.summary, context: s.title.split('·').pop()!.trim() });
    await db.commit();
    return { status: s.status, xp, learner: person(learner), comments: nComments };
  }));
}
