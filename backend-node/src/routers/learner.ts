/* Learner screens around learning: Beranda, Peta, Bab, Progres, activity, palette. */
import type { FastifyInstance } from 'fastify';

import { all, asc, count, type Db, desc, eq, first, get as getRow, ne, save, sql, T, where } from '../db.ts';
import { fail, int, model, optional, params } from '../http.ts';
import { fmt0, get, type Json, or, toInt, roundHalfEven, sortBy, sum, truthy } from '../util.ts';
import type { Chapter, ChapterProgress, Path, User } from '../schema.ts';
import { currentUser } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as content_svc from '../services/content.ts';
import * as learning from '../services/learning.ts';
import * as unlock from '../services/unlock.ts';
import { ago, person } from '../views.ts';
import { h } from './common.ts';

const PHASE_ICON: Record<string, string> = { pahami: 'book-open', perkuat: 'dumbbell', kuis: 'zap', uji: 'swords' };

export async function getChapter(db: Db, chapterId: number): Promise<Chapter> {
  const ch = await getRow(db, T.chapters, chapterId);
  if (!ch) fail(404, 'Bab tidak ditemukan.');
  return ch;
}

export function phaseLink(chapter: Chapter, phase: string, content: Json = null): string {
  if (phase === 'uji') {
    const mode = get(or(content, {}), 'uji_mode', 'any');
    if (mode === 'challenge') return `/bab/${chapter.id}/uji/challenge`;
    if (mode === 'ulangan') return `/bab/${chapter.id}/uji/ulangan`;
    return `/bab/${chapter.id}#uji`;
  }
  return `/bab/${chapter.id}/${phase}`;
}

export async function phaseMeta(db: Db, user: User, chapter: Chapter, prog: ChapterProgress | null | undefined, content: Json): Promise<Json[]> {
  const phases = prog ? prog.phases : unlock.initialPhases();
  const counts = content_svc.phaseCounts(content);
  const ring = unlock.ringValues(phases);
  const out: Json[] = [];
  for (const [i, ph] of unlock.PHASES.entries()) {
    const st = phases[ph];
    const state = st.state;
    let label = 'terkunci';
    if (ph === 'pahami') {
      if (state === 'done') label = 'selesai';
      else if (state === 'open') {
        const scene = await pahamiScene(db, user, chapter);
        label = scene > 1 ? `scene ${scene}/${counts.scenes}` : 'mulai';
      }
    } else if (ph === 'perkuat') {
      if (state === 'done') label = get(st, 'score') !== null ? `${fmt0(get(st, 'score', 100))}% tepat` : 'selesai';
      else if (state === 'open') label = `${await perkuatSolved(db, user, chapter)}/${counts.items} soal`;
    } else if (ph === 'kuis') {
      if (state === 'done') label = `lulus ${fmt0(get(st, 'score', 0))}%`;
      else if (state === 'open') label = get(st, 'score') !== null ? `terbaik ${fmt0(st.score!)}%` : 'terbuka';
    } else if (state === 'done') label = 'selesai';
    else if (state === 'open') label = 'terbuka';
    out.push({
      id: ph, label: unlock.PHASE_LABEL[ph], state, progress: ring[i],
      meta: `${String(i + 1).padStart(2, '0')} · ${label}`, short: label, icon: PHASE_ICON[ph], score: get(st, 'score'),
      link: phaseLink(chapter, ph, content),
    });
  }
  return out;
}

const stateOf = (db: Db, user: User, chapter: Chapter, phase: string) =>
  first(db, T.player_states, where(eq(T.player_states.user_id, user.id), eq(T.player_states.chapter_id, chapter.id), eq(T.player_states.phase, phase)));

export async function pahamiScene(db: Db, user: User, chapter: Chapter): Promise<number> {
  const st = await stateOf(db, user, chapter, 'pahami');
  return st ? toInt(get(or(st.data, {}), 'scene', 1)) : 1;
}

export async function perkuatSolved(db: Db, user: User, chapter: Chapter): Promise<number> {
  const st = await stateOf(db, user, chapter, 'perkuat');
  if (!st) return 0;
  const data = or(st.data, {});
  const inserted: string[] = get(data, 'inserted', []);
  const solved = get(data, 'solved', {});
  return get(data, 'order', []).filter((i: string) => !inserted.includes(i) && Object.hasOwn(solved, i)).length;
}

function etaMinutes(content: Json, phases: unlock.Phases): number {
  const mins = or(get(content, 'minutes'), {});
  let total = 0.0;
  for (const ph of unlock.PHASES) {
    const st = phases[ph];
    if (st.state === 'done') continue;
    total += or(get(mins, ph), 5) * (1 - Number(st.progress || 0));
  }
  return Math.max(1, roundHalfEven(total));
}

async function continueCard(db: Db, user: User, chapter: Chapter, prog: ChapterProgress, path: Path): Promise<Json> {
  const content = or(await content_svc.published(db, chapter, prog.version), {});
  const cur = unlock.currentPhase(prog.phases);
  const progress = Number(prog.phases[cur].progress || 0);
  const started = progress > 0 || cur !== 'pahami';
  const verb = {
    pahami: started ? 'Lanjut Pahami' : 'Mulai Pahami', perkuat: progress > 0 ? 'Lanjut Perkuat' : 'Mulai Perkuat',
    kuis: 'Mulai Kuis', uji: 'Pilih Uji',
  }[cur];
  return {
    chapter: learning.chapterRef(chapter),
    path: { slug: path.slug, title: path.title },
    phase: cur,
    phase_label: `Sedang ${unlock.PHASE_LABEL[cur]}`,
    phases: await phaseMeta(db, user, chapter, prog, content),
    ring: unlock.ringValues(prog.phases),
    done: unlock.doneCount(prog.phases),
    primary: { label: verb, href: phaseLink(chapter, cur, content) },
    eta: etaMinutes(content, prog.phases),
  };
}

function nudgeText(card: Json): string {
  if (!card) return 'Semua bab yang terbit sudah kamu selesaikan. Keren!';
  const left: string[] = card.phases.filter((p: Json) => p.state !== 'done' && p.id !== 'uji').map((p: Json) => p.label);
  const title = card.chapter.title;
  if (!left.length) return `Tinggal <b>Uji</b>, lalu ${title} selesai!`;
  if (left.length === 1) return `Tinggal <b>${left[0]}</b>, lalu ${title} bisa kamu uji!`;
  return 'Tinggal ' + left.slice(0, -1).map(l => `<b>${l}</b>`).join(', ') + ` dan <b>${left[left.length - 1]}</b>, lalu ${title} bisa kamu uji!`;
}

async function reviewCards(db: Db, user: User, limit = 3): Promise<Json[]> {
  const rows = await db.q.select({ m: T.concept_mastery, c: T.concepts }).from(T.concept_mastery)
    .innerJoin(T.concepts, eq(T.concepts.id, T.concept_mastery.concept_id))
    .where(where(eq(T.concept_mastery.user_id, user.id), eq(T.concept_mastery.weak, true)))
    .orderBy(desc(T.concept_mastery.updated_at), asc(T.concept_mastery.id)).limit(limit);
  const out: Json[] = [];
  for (const { m, c } of rows) {
    const ch = c.chapter_id ? await getRow(db, T.chapters, c.chapter_id) : undefined;
    const phase = m.weak_phase || 'perkuat';
    let action;
    if (phase === 'kuis') action = { label: 'Kuis 3 soal', icon: 'zap', href: `/bab/${c.chapter_id}/kuis?ulang=${c.key}` };
    else if (phase === 'uji' || phase === 'ulangan') action = { label: 'Ulang · 3 menit', icon: 'rotate-ccw', href: `/bab/${c.chapter_id}/perkuat?latih=${c.key}` };
    else action = { label: 'Lihat lagi scene-nya', icon: 'book-open', href: `/bab/${c.chapter_id}/pahami?konsep=${c.key}` };
    const src = ({ kuis: 'dari Kuis', ulangan: 'dari Ulangan', uji: 'dari Challenge', perkuat: 'dari Perkuat' } as Record<string, string>)[phase] ?? 'dari Perkuat';
    out.push({
      concept: c.key, name: c.name, phase: phase === 'ulangan' || phase === 'uji' ? 'uji' : phase, source: src,
      note: m.weak_note, tier: m.tier, chapter: ch ? ch.title : '', action,
    });
  }
  return out;
}

async function mentorNote(db: Db, user: User): Promise<Json> {
  const fromOthers = where(eq(T.messages.learner_id, user.id), ne(T.messages.author_id, user.id));
  const msg = await first(db, T.messages, fromOthers, desc(T.messages.created_at), asc(T.messages.id));
  if (!msg) return null;
  const author = await getRow(db, T.users, msg.author_id);
  const unread = await count(db, T.messages, where(fromOthers, eq(T.messages.read, false)));
  const href = msg.project_id ? `/proyek/${msg.project_id}` : '/progres#feedback';
  return { mentor: person(author), ago: ago(msg.created_at), context: msg.context, body: msg.body, unread, href };
}

async function projectCards(db: Db, user: User): Promise<Json[]> {
  const out: Json[] = [];
  for (const proj of await all(db, T.projects, undefined, asc(T.projects.number), asc(T.projects.id))) {
    const pp = await first(db, T.project_progress, where(eq(T.project_progress.user_id, user.id), eq(T.project_progress.project_id, proj.id)));
    if (!pp) continue;
    const n = proj.milestones.length;
    let ring = [0, 1, 2, 3].map(i => (i < pp.milestone ? 1.0 : i === pp.milestone && pp.status !== 'portfolio' ? 0.5 : 0.0));
    let meta: string;
    if (pp.status === 'portfolio') [ring, meta] = [[1.0, 1.0, 1.0, 1.0], 'terbit di portofolio'];
    else meta = `milestone ${pp.milestone + 1} dari ${n}` + (({ waiting: ' · menunggu review', feedback: ' · feedback baru' } as Record<string, string>)[pp.status] ?? '');
    out.push({ id: proj.id, title: proj.title, meta, ring, href: `/proyek/${proj.id}` });
  }
  return out;
}

async function nextProjectHint(db: Db): Promise<Json> {
  const proj = await first(db, T.projects, undefined, asc(T.projects.number), asc(T.projects.id));
  return proj ? { title: proj.title, after: proj.unlock_after } : null;
}

const studiedChapters = (pm: learning.ProgressMap) => [...pm.values()].filter(p => p.phases.pahami.state === 'done').length;

export async function userPath(db: Db, user: User): Promise<Path> {
  const klass = user.class_id ? await getRow(db, T.classes, user.class_id) : undefined;
  const path = klass && klass.path_id ? await getRow(db, T.paths, klass.path_id) : await first(db, T.paths, undefined, asc(T.paths.id));
  if (!path) fail(404, 'Belum ada jalur belajar.');
  return path;
}

function moduleOf(ch: Chapter, chapters: Chapter[]): string {
  let label = '';
  for (const c of chapters) {
    if (c.module_label) label = c.module_label;
    if (c.id === ch.id) break;
  }
  return label ? label.split('·').pop()!.trim() : '';
}

function trend(snaps: { week_start: string; pct: number }[]): Json[] {
  const today = activity.localToday();
  const thisWeek = activity.addDays(today, -activity.weekday(today));
  const byWeek = new Map(snaps.map(s => [s.week_start, s.pct]));
  return Array.from({ length: 8 }, (_, i) => {
    const w = activity.addDays(thisWeek, -7 * (7 - i));
    const earlier = snaps.filter(s => s.week_start <= w).map(s => s.pct);
    return { week: w, pct: byWeek.get(w) ?? (earlier.length ? earlier[earlier.length - 1] : 0) };
  });
}

async function ujiText(db: Db, user: User, c: Chapter): Promise<string> {
  const ex = await first(db, T.exam_sessions, where(eq(T.exam_sessions.user_id, user.id), eq(T.exam_sessions.chapter_id, c.id), eq(T.exam_sessions.passed, true)),
    desc(T.exam_sessions.score), asc(T.exam_sessions.id));
  if (ex) return `Ul · ${ex.score}`;
  const sub = await first(db, T.submissions, where(eq(T.submissions.user_id, user.id), eq(T.submissions.chapter_id, c.id), eq(T.submissions.kind, 'challenge')),
    desc(T.submissions.created_at), asc(T.submissions.id));
  if (sub) return `Ch · ${sub.tests_passed}/${sub.tests_total}`;
  return 'selesai';
}

async function tableRow(db: Db, user: User, c: Chapter, p: ChapterProgress | undefined, unlocked: boolean): Promise<Json> {
  const content = or(await content_svc.published(db, c, p ? p.version : null), {});
  let tier = 0;
  if (truthy(get(content, 'concepts'))) tier = roundHalfEven((await learning.chapterMasteryPct(db, user, c, content.concepts)) / 20);
  const dash = { text: '–', on: false };
  if (!p) {
    const none = !unlocked || !c.version ? 'terkunci' : '–';
    return { id: c.id, title: `${c.number} · ${c.title}`, active: false, cells: [{ text: none, on: false }, dash, dash, dash], tier: 0 };
  }
  const ph = p.phases;
  const counts = content_svc.phaseCounts(content);
  const cells: Json[] = [];
  cells.push({ text: ph.pahami.state === 'done' ? 'selesai' : `${await pahamiScene(db, user, c)}/${counts.scenes}`, on: true });
  if (ph.perkuat.state === 'done') cells.push({ text: `${fmt0(get(ph.perkuat, 'score', 100))}%`, on: true });
  else if (ph.perkuat.state === 'open') cells.push({ text: `${await perkuatSolved(db, user, c)}/${counts.items}`, on: true });
  else cells.push(dash);
  cells.push(get(ph.kuis, 'score') !== null ? { text: `${fmt0(ph.kuis.score!)}%`, on: true } : dash);
  cells.push(ph.uji.state === 'done' ? { text: await ujiText(db, user, c), on: true } : dash);
  return { id: c.id, title: `${c.number} · ${c.title}`, active: true, cells, tier };
}

const Heartbeat = model({ seconds: int({ default: 30 }), chapter_id: optional(int()) });

export default function learner(app: FastifyInstance) {
  app.get('/api/home', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const path = await userPath(db, user);
    const chapters = await learning.pathChapters(db, path.id);
    const pm = await learning.progressMap(db, user.id);
    const cur = await learning.currentChapter(db, user, chapters, pm);
    const card = cur ? await continueCard(db, user, cur, await learning.ensureProgress(db, user, cur), path) : null;
    await db.commit();
    const firstTime = (await activity.totalXp(db, user.id)) === 0 && !(await count(db, T.player_states, eq(T.player_states.user_id, user.id)));
    const nb = await first(db, T.notebooks, eq(T.notebooks.user_id, user.id), desc(T.notebooks.updated_at), asc(T.notebooks.id));
    const today = activity.localToday();
    const dailyDone = await count(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, user.id), eq(T.quiz_rounds.kind, 'daily'), eq(T.quiz_rounds.finished, true),
      sql`${T.quiz_rounds.created_at} >= ${activity.dayStart(today)}`));
    const firstChapter = chapters.find(c => c.kind === 'chapter');
    return {
      first_time: firstTime,
      nudge: nudgeText(card),
      continue: card,
      goal: { minutes: await activity.minutesOn(db, user.id, today), target: user.daily_goal_min },
      streak: { days: await activity.streak(db, user), week: await activity.weekDots(db, user) },
      daily_quiz: { available: studiedChapters(pm) > 0, done_today: dailyDone > 0, xp: 20 },
      review: await reviewCards(db, user),
      mentor: await mentorNote(db, user),
      projects: await projectCards(db, user),
      notebook: nb ? { id: nb.id, title: nb.title, ago: ago(nb.updated_at) } : null,
      next_project: await nextProjectHint(db),
      first_chapter: chapters.length && firstChapter ? learning.chapterRef(firstChapter) : null,
    };
  }));

  app.get('/api/paths', h(async (req, _reply, db) => {
    await currentUser(req, db);
    return (await all(db, T.paths, undefined, asc(T.paths.id))).map(p => ({ slug: p.slug, title: p.title }));
  }));

  app.get('/api/paths/:slug/map', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const { slug } = req.params as { slug: string };
    const path = await first(db, T.paths, eq(T.paths.slug, slug));
    if (!path) fail(404, 'Jalur tidak ditemukan.');
    const chapters = await learning.pathChapters(db, path.id);
    const pm = await learning.progressMap(db, user.id);
    const cur = await learning.currentChapter(db, user, chapters, pm);
    const nodes: Json[] = [];
    let prevLearn: Chapter | null = null;
    for (const c of chapters) {
      const prog = pm.get(c.id);
      const state = await learning.nodeState(db, user, c, chapters, pm, cur ? cur.id : null);
      let ring = prog ? unlock.ringValues(prog.phases) : [0.0, 0.0, 0.0, 0.0];
      const phases = unlock.PHASES.map((ph, i) => ({ id: ph, label: unlock.PHASE_LABEL[ph], value: ring[i] }));
      let lockMsg: string, href: string;
      if (c.kind === 'project' && c.project_id) {
        const pp = await first(db, T.project_progress, where(eq(T.project_progress.user_id, user.id), eq(T.project_progress.project_id, c.project_id)));
        const proj = await getRow(db, T.projects, c.project_id);
        const n = proj ? proj.milestones.length : 4;
        const doneMs = pp ? (pp.status === 'portfolio' ? n : pp.milestone) : 0;
        ring = [0, 1, 2, 3].map(i => (i < doneMs ? 1.0 : 0.0));
        lockMsg = proj ? `Selesaikan Bab ${proj.unlock_after} dulu untuk membuka proyek ini.` : '';
        href = `/proyek/${c.project_id}`;
      } else {
        const need = prevLearn;
        lockMsg = c.kind === 'chapter'
          ? (need ? `Selesaikan Uji di Bab ${need.number} · ${need.title} untuk membukanya.` : 'Bab ini belum terbuka.')
          : 'Selesaikan semua bab untuk membuka ujian akhir.';
        href = `/bab/${c.id}`;
      }
      if (state === 'soon') lockMsg = 'Bab ini sedang disiapkan tim kurikulum. Segera hadir.';
      nodes.push({
        id: c.id, number: c.number, kind: c.kind, title: c.title, subtitle: c.subtitle, icon: c.icon,
        module: c.module_label, x: c.map_x, ring, phases, state, href, lock_message: lockMsg, published: Boolean(c.version),
      });
      if (c.kind === 'chapter') prevLearn = c;
    }
    const learn = chapters.filter(c => c.kind === 'chapter');
    const done = learn.filter(c => pm.get(c.id)?.completed_at).length;
    const totalPhases = 4 * learn.length;
    const donePhases = sum(learn.filter(c => pm.has(c.id)).map(c => unlock.doneCount(pm.get(c.id)!.phases)));
    return {
      path: { slug: path.slug, title: path.title, description: path.description },
      nodes,
      current_id: cur ? cur.id : null,
      summary: {
        chapters_done: done, chapters_total: learn.length, phases_done: donePhases, phases_total: totalPhases,
        pct: totalPhases ? roundHalfEven((100 * donePhases) / totalPhases) : 0,
        ring: [0, 1, 2, 3].map(i => (totalPhases ? Math.min(1.0, Math.max(0.0, (donePhases / totalPhases) * 4 - i)) : 0)),
      },
      other_paths: (await all(db, T.paths, ne(T.paths.id, path.id))).map(p => ({ slug: p.slug, title: p.title })),
    };
  }));

  app.get('/api/chapters/:chapter_id', { schema: { params: params(['chapter_id']) } }, h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as { chapter_id: number }).chapter_id);
    if (ch.kind !== 'chapter') fail(404, 'Bukan bab belajar.');
    const chapters = await learning.pathChapters(db, ch.path_id);
    const pm = await learning.progressMap(db, user.id);
    const unlocked = await learning.isUnlocked(db, user, ch, chapters, pm);
    if (!ch.version) fail(409, { code: 'soon', message: `Bab ${ch.number} segera hadir`, detail: 'Bab ini sedang disiapkan tim kurikulum.', redirect: '/peta' });
    if (!unlocked && user.role === 'learner') {
      const prev = chapters.filter(c => c.kind === 'chapter' && c.position < ch.position);
      const need = prev.length ? prev[prev.length - 1] : null;
      fail(409, {
        code: 'locked', message: `Bab ${ch.number} masih terkunci`, redirect: '/peta',
        detail: need ? `Selesaikan Uji di Bab ${need.number} · ${need.title} untuk membukanya.` : '',
      });
    }
    const prog = await learning.ensureProgress(db, user, ch);
    await db.commit();
    const content = or(await content_svc.published(db, ch, prog.version), {});
    const path = (await getRow(db, T.paths, ch.path_id))!;
    const counts = content_svc.phaseCounts(content);
    const kuis = or(get(content, 'kuis'), {});
    const ul = or(get(content, 'ulangan'), {});
    const chal = or(get(content, 'challenge'), {});
    const phases = await phaseMeta(db, user, ch, prog, content);
    const cur = unlock.currentPhase(prog.phases);
    const keys: string[] = get(content, 'concepts', []);
    const concepts = await learning.conceptsByKey(db, ch.path_id, keys);
    const mrows = new Map((await all(db, T.concept_mastery, eq(T.concept_mastery.user_id, user.id))).map(r => [r.concept_id, r]));
    const order = new Map(keys.map((k, i) => [k, i]));
    const skills = sortBy(concepts.map(c => ({
      key: c.key, name: c.name, skill: c.skill || c.name, tier: mrows.get(c.id)?.tier ?? 0, weak: Boolean(mrows.get(c.id)?.weak),
    })), s => [order.get(s.key) ?? 99]);
    const learn = chapters.filter(c => c.kind === 'chapter');
    let primaryLabel = { pahami: 'Mulai Pahami', perkuat: 'Lanjut Perkuat', kuis: 'Mulai Kuis', uji: 'Pilih Uji' }[cur];
    if (cur === 'pahami' && Number(prog.phases.pahami.progress || 0) > 0) primaryLabel = `Lanjut Pahami · scene ${await pahamiScene(db, user, ch)}`;
    if (cur === 'perkuat' && (await perkuatSolved(db, user, ch)) > 0) primaryLabel = `Lanjut Perkuat · soal ${(await perkuatSolved(db, user, ch)) + 1}`;
    if (prog.completed_at) primaryLabel = 'Ulas Pahami';
    const mins = or(get(content, 'minutes'), {});
    const items: Json[] = get(get(content, 'perkuat', {}), 'items', []);
    const primaryPhase = prog.completed_at ? 'pahami' : cur;
    return {
      chapter: { ...learning.chapterRef(ch), description: ch.description, subtitle: ch.subtitle, icon: ch.icon, module: moduleOf(ch, chapters) },
      path: { slug: path.slug, title: path.title },
      position: { number: ch.number, total: learn.length },
      phases,
      current: cur,
      completed: Boolean(prog.completed_at),
      ring: unlock.ringValues(prog.phases),
      primary: { label: primaryLabel, href: phaseLink(ch, primaryPhase, content), phase: primaryPhase },
      eta: { total: sum(Object.values(mins).map(v => toInt(or(v, 0)))), left: prog.completed_at ? 0 : etaMinutes(content, prog.phases) },
      facts: {
        scenes: counts.scenes,
        live: get(get(content, 'pahami', {}), 'scenes', []).filter((s: Json) => ['livecode', 'knobcalc'].includes(get(or(get(s, 'visual'), {}), 'type'))).length,
        pahami_minutes: get(mins, 'pahami', 6), items: counts.items,
        types: new Set(items.map(i => (i.type !== 'predict' ? i.type : 'choice'))).size,
        round: get(kuis, 'round_size', 10), seconds: get(kuis, 'seconds', 20), pass_pct: get(kuis, 'pass_pct', 70),
        exam: truthy(get(ul, 'questions')) ? { count: get(ul, 'questions', []).length, minutes: get(ul, 'minutes', 30), pass: get(ul, 'pass_mark', 75) } : null,
        challenge: truthy(chal) ? { title: get(chal, 'title', '') } : null,
        uji_mode: get(content, 'uji_mode', 'any'),
      },
      skills,
      cheatsheet: prog.phases.pahami.state === 'done' ? get(content, 'cheatsheet', '') : null,
    };
  }));

  app.get('/api/progress', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const path = await userPath(db, user);
    const chapters = await learning.pathChapters(db, path.id);
    const pm = await learning.progressMap(db, user.id);
    const learn = chapters.filter(c => c.kind === 'chapter');
    const cur = await learning.currentChapter(db, user, chapters, pm);
    // constellation
    const concepts = await all(db, T.concepts, eq(T.concepts.path_id, path.id));
    const mrows = new Map((await all(db, T.concept_mastery, eq(T.concept_mastery.user_id, user.id))).map(r => [r.concept_id, r]));
    const byKey = new Set(concepts.map(c => c.key));
    const stars = concepts.map(c => {
      const m = mrows.get(c.id);
      const tier = m ? m.tier : 0;
      const state = tier === 0 ? 'off' : m && m.weak ? 'weak' : 'on';
      return { key: c.key, name: c.name, x: c.x, y: c.y, mastery: roundHalfEven(tier / 5, 2), state, tier };
    });
    const edges = concepts.flatMap(c => (c.requires || []).filter(req => byKey.has(req)).map(req => [req, c.key]));
    // kpis
    const firstTry = (await db.q.select({ correct: T.attempts.correct }).from(T.attempts)
      .where(where(eq(T.attempts.user_id, user.id), eq(T.attempts.phase, 'perkuat'), eq(T.attempts.attempt_no, 1)))).map(r => r.correct);
    const acc = firstTry.length ? roundHalfEven((100 * firstTry.filter(Boolean).length) / firstTry.length) : 0;
    const mastery = await learning.overallMasteryPct(db, user, path.id);
    const snaps = await all(db, T.mastery_snapshots, eq(T.mastery_snapshots.user_id, user.id), asc(T.mastery_snapshots.week_start), asc(T.mastery_snapshots.id));
    const tr = trend(snaps);
    const delta = tr.length >= 2 ? tr[tr.length - 1].pct - tr[tr.length - 2].pct : 0;
    const curProg = cur ? pm.get(cur.id) : undefined;
    const rows: Json[] = [];
    for (const c of learn) rows.push(await tableRow(db, user, c, pm.get(c.id), await learning.isUnlocked(db, user, c, chapters, pm)));
    return {
      kpis: {
        mastery, mastery_delta: delta,
        chapters_done: learn.filter(c => pm.get(c.id)?.completed_at).length, chapters_total: learn.length,
        current_text: cur && curProg ? `Bab ${cur.number} di fase ${unlock.PHASE_LABEL[unlock.currentPhase(curProg.phases)]}` : 'semua bab terbit selesai',
        accuracy: acc, xp: await activity.totalXp(db, user.id), streak: await activity.streak(db, user),
      },
      path: { slug: path.slug, title: path.title },
      stars, edges, trend: tr,
      review: await reviewCards(db, user, 5),
      mentor: await mentorNote(db, user),
      table: rows,
    };
  }));

  app.post('/api/activity/heartbeat', { schema: { body: Heartbeat } }, h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { seconds: number; chapter_id: number | null };
    await activity.recordActivity(db, user, body.seconds);
    if (body.chapter_id) {
      const p = await first(db, T.chapter_progress, where(eq(T.chapter_progress.user_id, user.id), eq(T.chapter_progress.chapter_id, body.chapter_id)));
      if (p && !p.completed_at)
        await save(db, T.chapter_progress, p, { active_seconds: p.active_seconds + Math.max(0, Math.min(activity.HEARTBEAT_MAX_SECONDS, body.seconds)) });
    }
    await db.commit();
    return { today_minutes: await activity.minutesOn(db, user.id, activity.localToday()), streak: await activity.streak(db, user) };
  }));

  app.get('/api/notifications', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const rows = await db.q.select().from(T.notifications).where(eq(T.notifications.user_id, user.id))
      .orderBy(desc(T.notifications.created_at), asc(T.notifications.id)).limit(30);
    return rows.map(n => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, read: n.read, ago: ago(n.created_at) }));
  }));

  app.post('/api/notifications/read', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    await db.q.update(T.notifications).set({ read: true }).where(where(eq(T.notifications.user_id, user.id), eq(T.notifications.read, false)));
    await db.commit();
    return { ok: true };
  }));

  /** Items for the ⌘K command palette. */
  app.get('/api/palette', h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    if (user.role !== 'learner') return { continue: [], chapters: [], concepts: [] };
    const path = await userPath(db, user);
    const chapters = await learning.pathChapters(db, path.id);
    const pm = await learning.progressMap(db, user.id);
    const cur = await learning.currentChapter(db, user, chapters, pm);
    const cont: Json[] = [];
    if (cur && pm.has(cur.id)) {
      const p = pm.get(cur.id)!;
      const content = or(await content_svc.published(db, cur, p.version), {});
      const ph = unlock.currentPhase(p.phases);
      const meta = (await phaseMeta(db, user, cur, p, content)).find(m => m.id === ph);
      cont.push({ icon: 'play', title: `Lanjut: ${cur.title}`, hint: `${unlock.PHASE_LABEL[ph]} · ${meta.short}`, href: meta.link });
    }
    if (studiedChapters(pm)) cont.push({ icon: 'zap', title: 'Kuis harian', hint: '5 soal · 2 menit', href: '/kuis-harian' });
    const chs: Json[] = [];
    for (const c of chapters) {
      if (c.kind !== 'chapter' || !c.version) continue;
      if (await learning.isUnlocked(db, user, c, chapters, pm)) chs.push({ icon: c.icon, title: `Bab ${c.number} · ${c.title}`, hint: c.subtitle, href: `/bab/${c.id}` });
    }
    const concepts: Json[] = [];
    for (const c of await all(db, T.concepts, eq(T.concepts.path_id, path.id))) {
      const ch = c.chapter_id ? await getRow(db, T.chapters, c.chapter_id) : undefined;
      if (ch && ch.version && pm.has(ch.id)) concepts.push({ icon: 'sparkles', title: c.name, hint: `konsep · Bab ${ch.number}`, href: `/bab/${ch.id}/pahami?konsep=${c.key}` });
    }
    return { continue: cont, chapters: chs, concepts };
  }));
}
