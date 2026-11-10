/* The four phases inside the lesson player: Pahami, Perkuat, Kuis, Uji (Ulangan / Challenge).

Answer keys never leave the server. Every endpoint checks that the phase is open for the learner;
deep links to a locked phase get HTTP 409 with a `redirect` so the UI can send the learner back to
the chapter page. */
import type { FastifyInstance } from 'fastify';

import { settings } from '../config.ts';
import { count, type Db, desc, eq, first, get as getRow, insert, save, sql, T, where, withDb } from '../db.ts';
import { anyValue, dict, fail, HttpError, int, list, model, optional, params, str } from '../http.ts';
import { cut, get, type Json, or, toInt, roundHalfEven, toStr, sample, shuffle, sum, truthy } from '../util.ts';
import type { Chapter, ChapterProgress, ExamSession, QuizRound, User } from '../schema.ts';
import { currentUser, userFromToken } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as content_svc from '../services/content.ts';
import * as learning from '../services/learning.ts';
import * as runner from '../services/runner.ts';
import * as scoring from '../services/scoring.ts';
import * as unlock from '../services/unlock.ts';
import { h } from './common.ts';
import { getChapter, phaseMeta } from './learner.ts';

const PRAISE = ['Mantap!', 'Tepat sekali!', 'Keren!', 'Betul!'];
const plain = (s: string | null | undefined) => (s || '').replace(/<[^>]+>/g, '').trim();
const chapterParam = { params: params(['chapter_id']) };

// ------------------------------------------------------------------ guards
export async function requirePhase(db: Db, user: User, ch: Chapter, phase: string): Promise<[ChapterProgress, Json]> {
  if (!ch.version) fail(409, { code: 'soon', message: 'Bab ini sedang disiapkan.', redirect: '/peta' });
  if (user.role === 'learner' && !(await learning.isUnlocked(db, user, ch)))
    fail(409, { code: 'locked', message: `Bab ${ch.number} masih terkunci`, redirect: '/peta' });
  const prog = await learning.ensureProgress(db, user, ch);
  if (!unlock.isOpen(prog.phases, phase)) {
    const i = unlock.PHASES.indexOf(phase as unlock.Phase);
    const prev = unlock.PHASES.at(i - 1)!;
    await db.commit();
    fail(409, {
      code: 'phase_locked', message: `Selesaikan ${unlock.PHASE_LABEL[prev]} dulu`,
      detail: `${unlock.PHASE_LABEL[phase]} terbuka setelah ${unlock.PHASE_LABEL[prev]} selesai.`, redirect: `/bab/${ch.id}`,
    });
  }
  return [prog, or(await content_svc.published(db, ch, prog.version), {})];
}

async function header(db: Db, user: User, ch: Chapter, prog: ChapterProgress, content: Json): Promise<Json> {
  return {
    chapter: learning.chapterRef(ch),
    phases: await phaseMeta(db, user, ch, prog, content),
    xp: await activity.weekXp(db, user.id),
    streak: await activity.streak(db, user),
  };
}

const assistCap = (user: User) => Math.max(0, Math.min(6, user.assist_cap ?? 6));

const bodyMode = (req: { body?: unknown }) => (get(req.body ?? {}, 'mode') === 'mini' ? 'mini' : 'phase');

// ================================================================= PERKUAT
const perkuatItems = (content: Json): Json[] => get(get(content, 'perkuat', {}), 'items', []);

async function perkuatState(db: Db, user: User, ch: Chapter, content: Json, mode: string) {
  const st = await learning.playerState(db, user, ch, mode === 'phase' ? 'perkuat' : 'mini');
  let data: Json = { ...st.data };
  if (mode === 'phase' && !truthy(get(data, 'order'))) {
    data = {
      order: perkuatItems(content).filter(i => !truthy(get(i, 'adaptive'))).map(i => i.id), index: 0, solved: {}, attempts: {},
      hint: {}, first_try: {}, inserted: [], inserted_for: [],
    };
    await learning.saveState(db, st, data);
  }
  return { st, data };
}

async function perkuatView(db: Db, user: User, ch: Chapter, prog: ChapterProgress, content: Json, data: Json, mode: string): Promise<Json> {
  const byId = new Map(perkuatItems(content).map(i => [i.id, i]));
  const order: string[] = get(data, 'order', []).filter((i: string) => byId.has(i));
  const inserted: string[] = get(data, 'inserted', []);
  const pub = order.map(iid => ({ ...content_svc.perkuatItemPublic(byId.get(iid)), similar: inserted.includes(iid) }));
  const cap = assistCap(user);
  return {
    ...(await header(db, user, ch, prog, content)),
    mode,
    items: pub,
    index: Math.min(toInt(get(data, 'index', 0)), Math.max(0, order.length - 1)),
    solved: get(data, 'solved', {}),
    attempts: get(data, 'attempts', {}),
    hint: get(data, 'hint', {}),
    assist_cap: Math.min(cap, 5),
    solution_allowed: cap >= 6,
    done: mode === 'phase' ? prog.phases.perkuat.state === 'done' : false,
    kuis: { round: get(get(content, 'kuis', {}), 'round_size', 10) },
    praise: PRAISE,
  };
}

const hintLevels = (item: Json, cap: number) => {
  const hints = or(get(item, 'hints'), {});
  return { hints, available: [3, 4, 5].filter(lvl => truthy(get(hints, `l${lvl}`)) && lvl <= cap) };
};

// ==================================================================== KUIS
function kuisCfg(content: Json) {
  const k = or(get(content, 'kuis'), {});
  return { round_size: get(k, 'round_size', 10), seconds: get(k, 'seconds', 20), pass_pct: get(k, 'pass_pct', 70), combo_max: get(k, 'combo_max', 3) };
}

function ujiOptions(content: Json): Json {
  const mode = get(content, 'uji_mode', 'any');
  const ul = or(get(content, 'ulangan'), {});
  return {
    ulangan: truthy(get(ul, 'questions')) && ['any', 'ulangan'].includes(mode),
    challenge: truthy(get(content, 'challenge')) && ['any', 'challenge'].includes(mode),
    exam: { count: get(ul, 'questions', []).length, minutes: get(ul, 'minutes', 30), pass: get(ul, 'pass_mark', 75) },
    challenge_title: get(or(get(content, 'challenge'), {}), 'title', ''),
  };
}

async function roundQuestions(db: Db, rnd: QuizRound): Promise<Json[]> {
  const cache = new Map<number, Json>();
  const out: Json[] = [];
  for (const [cid, qid] of rnd.question_refs) {
    if (!cache.has(cid)) {
      const ch = (await getRow(db, T.chapters, cid))!;
      cache.set(cid, or(await content_svc.published(db, ch, rnd.chapter_id === cid ? rnd.version : null), {}));
    }
    out.push(content_svc.find(get(get(cache.get(cid), 'kuis', {}), 'bank', []), qid) ?? { id: qid, t: '(soal dihapus)', o: ['-', '-', '-', '-'], a: 0, e: '' });
  }
  return out;
}

async function getRound(db: Db, user: User, roundId: number): Promise<QuizRound> {
  const rnd = await getRow(db, T.quiz_rounds, roundId);
  if (!rnd || rnd.user_id !== user.id) fail(404, 'Ronde tidak ditemukan.');
  return rnd;
}

const attemptNo = async (db: Db, user: User, phase: string, itemId: string) =>
  1 + (await count(db, T.attempts, where(eq(T.attempts.user_id, user.id), eq(T.attempts.phase, phase), eq(T.attempts.item_id, itemId))));

// ================================================================= ULANGAN
function exam(content: Json): Json {
  const ex = or(get(content, 'ulangan'), {});
  if (!truthy(get(ex, 'questions'))) fail(404, 'Bab ini tidak punya ulangan.');
  return ex;
}

function examResult(s: ExamSession): Json {
  const used = s.submitted_at ? (s.submitted_at.getTime() - s.started_at.getTime()) / 1000 : 0;
  const two = (n: number) => String(Math.trunc(n)).padStart(2, '0');
  return { score: s.score, passed: s.passed, rows: s.results || [], used: `${two(Math.floor(used / 60))}:${two(used % 60)}` };
}

function sessionView(s: ExamSession, content: Json): Json {
  const ex = exam(content);
  return {
    id: s.id, deadline: s.deadline.toISOString(), server_now: new Date().toISOString(),
    answers: s.answers || {}, flags: s.flags || [], submitted: Boolean(s.submitted_at),
    questions: ex.questions.map(content_svc.examQuestionPublic),
    minutes: get(ex, 'minutes', 30), pass_mark: get(ex, 'pass_mark', 75),
    result: s.submitted_at ? examResult(s) : null,
  };
}

async function getSession(db: Db, user: User, sid: number): Promise<ExamSession> {
  const s = await getRow(db, T.exam_sessions, sid);
  if (!s || s.user_id !== user.id) fail(404, 'Sesi ulangan tidak ditemukan.');
  return s;
}

const blank = (v: Json) => v === null || v === undefined || v === '';

async function grade(db: Db, user: User, ch: Chapter, s: ExamSession, content: Json): Promise<Json> {
  const ex = exam(content);
  const rows: Json[] = [];
  let total = 0, got = 0;
  for (const [idx, q] of (ex.questions as Json[]).entries()) {
    const i = idx + 1;
    const ans = get(s.answers || {}, q.id);
    const pts = toInt(get(q, 'pts', 10));
    total += pts;
    let note = '', earned: number, ok: boolean;
    if (q.type === 'code') {
      if (!truthy(ans)) [earned, ok] = [0, false];
      else {
        const res = await runner.run(toStr(ans), get(q, 'tests', []));
        const passed = res.results.filter((r: Json) => r.pass).length;
        const n = Math.max(1, res.results.length);
        earned = roundHalfEven((pts * passed) / n);
        ok = passed === n;
        if (!ok) note = runner.errorText(get(res, 'error')) || (res.results.find((r: Json) => !r.pass)?.detail ?? '');
      }
    } else {
      ok = Boolean(content_svc.checkExamStatic(q, ans));
      earned = ok ? pts : 0;
      if (!ok && !blank(ans)) {
        const right = q.type === 'choice' ? q.o[q.answer] : or(get(q, 'accept'), [''])[0];
        const s = toStr(ans);
        const given = q.type === 'choice' && /^\d+$/.test(s.replace(/^-+/, '')) && toInt(ans) >= 0 && toInt(ans) < q.o.length ? q.o[toInt(ans)] : ans;
        note = `Kamu menjawab ${plain(toStr(given))}, seharusnya ${plain(toStr(right))}.`;
      } else if (!ok) note = 'Belum dijawab.';
    }
    got += earned;
    await insert(db, T.attempts, {
      user_id: user.id, chapter_id: ch.id, phase: 'ulangan', item_id: q.id, correct: ok, answer: ans ?? null, version: s.version,
      attempt_no: await attemptNo(db, user, 'ulangan', q.id),
    });
    if (ok) await learning.touchMastery(db, user, ch.path_id, get(q, 'concepts', []), 4, 'Ulangan benar');
    else {
      await learning.markWeak(db, user, ch.path_id, get(q, 'concepts', []), 'ulangan', note ? `${note} (Ulangan · soal ${i})` : `Salah di Ulangan · soal ${i}.`);
      if (note) note += ' Konsep ini ditambahkan ke <b>Perlu diulang</b>.';
    }
    rows.push({ n: i, label: or(get(q, 'label'), cut(plain(q.t), 60)), ok, pts: earned, max: pts, note });
  }
  const score = total ? roundHalfEven((100 * got) / total) : 0;
  await save(db, T.exam_sessions, s, { score, results: rows, submitted_at: new Date(), passed: score >= toInt(get(ex, 'pass_mark', 75)) });
  let out: Json = { chapter_done: false, xp: 0 };
  if (s.passed) {
    const prog = await learning.ensureProgress(db, user, ch);
    if (prog.phases.uji.state !== 'done') {
      if (score >= 90) await learning.touchMastery(db, user, ch.path_id, get(content, 'concepts', []), 5, 'Ulangan ≥ 90');
      const res = await learning.completePhase(db, user, ch, 'uji', score);
      out = {
        chapter_done: res.chapter_done, xp: res.xp, next_chapter: res.next_chapter,
        mastery: await learning.chapterMasteryPct(db, user, ch, get(content, 'concepts', [])),
      };
    }
  }
  return out;
}

// =============================================================== CHALLENGE
async function mentorName(db: Db, user: User): Promise<string | null> {
  const klass = user.class_id ? await getRow(db, T.classes, user.class_id) : undefined;
  const m = klass && klass.mentor_id ? await getRow(db, T.users, klass.mentor_id) : undefined;
  return m ? m.name.trim().split(/\s+/)[0] : null;
}

/** Runs the tests and records the attempt. Returns [run result, outcome]. */
async function runChallenge(db: Db, user: User, ch: Chapter, code: string): Promise<[Json, Json]> {
  const [prog, content] = await requirePhase(db, user, ch, 'uji');
  const chal = or(get(content, 'challenge'), {});
  const tests: Json[] = get(chal, 'tests', []);
  const res = await runner.run(code, tests);
  const passed = res.results.filter((r: Json) => r.pass).length;
  const allPass = passed === tests.length && tests.length > 0;
  const n = 1 + (await count(db, T.attempts, where(eq(T.attempts.user_id, user.id), eq(T.attempts.chapter_id, ch.id), eq(T.attempts.phase, 'challenge'))));
  await insert(db, T.attempts, {
    user_id: user.id, chapter_id: ch.id, phase: 'challenge', item_id: 'challenge', attempt_no: n, correct: allPass,
    answer: { code, passed, total: tests.length, error: get(res, 'error') }, version: prog.version,
  });
  const st = await learning.playerState(db, user, ch, 'challenge');
  await learning.saveState(db, st, { ...st.data, code });
  const outcome: Json = { passed, total: tests.length, all_pass: allPass, attempt: n, chapter_done: false, xp: 0 };
  const byId = new Map(tests.map(t => [t.id, t]));
  for (const r of res.results) r.name = get(byId.get(r.id) ?? {}, 'name', '');
  if (allPass && prog.phases.uji.state !== 'done') {
    await learning.touchMastery(db, user, ch.path_id, get(content, 'concepts', []), 4, 'Challenge lulus');
    await learning.touchMastery(db, user, ch.path_id, get(chal, 'concepts', []), 5, 'Challenge lulus');
    const res2 = await learning.completePhase(db, user, ch, 'uji', 100);
    const sub = await insert(db, T.submissions, {
      user_id: user.id, kind: 'challenge', chapter_id: ch.id, title: `Challenge · Bab ${ch.number} · ${get(chal, 'title', '')}`,
      filename: get(chal, 'filename', 'main.js'), code, attempt_no: n, tests_passed: passed, tests_total: tests.length,
    });
    const klass = user.class_id ? await getRow(db, T.classes, user.class_id) : undefined;
    if (klass && klass.mentor_id) await learning.notify(db, klass.mentor_id, 'review', `${user.name} minta review`, sub.title, '/mentor/review');
    Object.assign(outcome, {
      chapter_done: res2.chapter_done, xp: res2.xp, next_chapter: res2.next_chapter,
      mastery: await learning.chapterMasteryPct(db, user, ch, get(content, 'concepts', [])),
    });
  } else if (!allPass) {
    const failed: string[] = get(chal, 'concepts', []);
    if (n >= 3 && failed.length) await learning.markWeak(db, user, ch.path_id, failed, 'uji', `Challenge belum lulus setelah ${n} percobaan.`);
  }
  await activity.recordActivity(db, user, 0);
  await db.commit();
  return [res, outcome];
}

// ================================================================== routes
const SceneIn = model({ scene: int() });
const MiniIn = model({ concepts: list(str(), { default: [] }), round_id: optional(int()) });
const CheckIn = model({ item_id: str(), answer: anyValue({ default: null }), ms: int({ default: 0 }), mode: str({ default: 'phase' }) });
const HintIn = model({ item_id: str(), ms_since_shown: int({ default: 0 }), mode: str({ default: 'phase' }) });
const SolutionIn = model({ item_id: str(), mode: str({ default: 'phase' }) });
const IndexIn = model({ index: int(), mode: str({ default: 'phase' }) });
const RoundIn = model({ kind: str({ default: 'gate' }), concept: optional(str()) }); // kind: gate | review
const AnswerIn = model({ index: int(), choice: int(), left: int({ default: 0 }) }); // choice -1 = timeout
const ExamAnswerIn = model({ qid: str(), answer: anyValue({ default: null }) });
const FlagsIn = model({ flags: list(str()) });
const DraftIn = model({ code: str() });
const ReportIn = model({ test_id: str(), body: str({ default: '' }) });
const roundParam = { params: params(['round_id']) };
const sidParam = { params: params(['sid']) };

type P = { chapter_id: number; round_id: number; sid: number };

export default function player(app: FastifyInstance) {
  // ---------------------------------------------------------------- PAHAMI
  app.get('/api/chapters/:chapter_id/pahami', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'pahami');
    const st = await learning.playerState(db, user, ch, 'pahami');
    await db.commit();
    const scenes: Json[] = get(get(content, 'pahami', {}), 'scenes', []);
    return {
      ...(await header(db, user, ch, prog, content)),
      scenes,
      scene: Math.min(Math.max(1, toInt(get(st.data, 'scene', 1))), Math.max(1, scenes.length)),
      done: prog.phases.pahami.state === 'done',
      minutes: get(or(get(content, 'minutes'), {}), 'pahami', 6),
      next: { items: content_svc.phaseCounts(content).items },
    };
  }));

  app.post('/api/chapters/:chapter_id/pahami/scene', { schema: { ...chapterParam, body: SceneIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'pahami');
    const n = get(get(content, 'pahami', {}), 'scenes', []).length || 1;
    const scene = Math.max(1, Math.min(n, (req.body as { scene: number }).scene));
    const st = await learning.playerState(db, user, ch, 'pahami');
    const data: Json = { ...st.data, scene };
    data.max_scene = Math.max(scene, toInt(get(data, 'max_scene', 1)));
    await learning.saveState(db, st, data);
    await learning.setPhaseProgress(db, prog, 'pahami', (data.max_scene - 1) / n);
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return { scene, progress: prog.phases.pahami.progress };
  }));

  app.post('/api/chapters/:chapter_id/pahami/complete', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [, content] = await requirePhase(db, user, ch, 'pahami');
    const res = await learning.completePhase(db, user, ch, 'pahami');
    await db.commit();
    return { ...res, xp_week: await activity.weekXp(db, user.id), next: { items: content_svc.phaseCounts(content).items } };
  }));

  // --------------------------------------------------------------- PERKUAT
  app.get('/api/chapters/:chapter_id/perkuat', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'perkuat');
    const { data } = await perkuatState(db, user, ch, content, 'phase');
    await db.commit();
    return perkuatView(db, user, ch, prog, content, data, 'phase');
  }));

  /** Perkuat mini: 3 items for the missed concepts. Available once Perkuat is open; never changes phase state. */
  app.post('/api/chapters/:chapter_id/perkuat/mini', { schema: { ...chapterParam, body: MiniIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { concepts: string[]; round_id: number | null };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'perkuat');
    const concepts = new Set(body.concepts);
    if (body.round_id) {
      const rnd = await getRow(db, T.quiz_rounds, body.round_id);
      if (rnd && rnd.user_id === user.id) {
        const bank = new Map<string, Json>(get(get(content, 'kuis', {}), 'bank', []).map((q: Json) => [q.id, q]));
        rnd.question_refs.forEach(([, qid], i) => {
          const ans = rnd.answers[i];
          if (ans !== undefined && !truthy(get(ans, 'correct')) && bank.has(qid)) for (const c of get(bank.get(qid), 'concepts', [])) concepts.add(c);
        });
      }
    }
    const items = perkuatItems(content);
    const matching = items.filter(i => get(i, 'concepts', []).some((c: string) => concepts.has(c)));
    const pool = shuffle(matching.length ? matching : [...items]);
    const st = await learning.playerState(db, user, ch, 'mini');
    await learning.saveState(db, st, {
      order: pool.slice(0, 3).map(i => i.id), index: 0, solved: {}, attempts: {}, hint: {}, first_try: {},
      inserted: [], inserted_for: [], concepts: [...concepts].sort(),
    });
    await db.commit();
    return perkuatView(db, user, ch, prog, content, st.data, 'mini');
  }));

  app.post('/api/chapters/:chapter_id/perkuat/check', { schema: { ...chapterParam, body: CheckIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { item_id: string; answer: Json; ms: number; mode: string };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'perkuat');
    const mode = body.mode === 'mini' ? 'mini' : 'phase';
    const { st, data } = await perkuatState(db, user, ch, content, mode);
    const items = perkuatItems(content);
    const item = content_svc.find(items, body.item_id);
    if (!item || !get(data, 'order', []).includes(body.item_id)) fail(404, 'Soal tidak ditemukan.');
    const [ok, marks] = content_svc.checkPerkuat(item, body.answer);
    const iid: string = item.id;
    const attempts = { ...get(data, 'attempts', {}) };
    attempts[iid] = get(attempts, iid, 0) + 1;
    const n: number = attempts[iid];
    data.attempts = attempts;
    const hint = { ...get(data, 'hint', {}) };
    await insert(db, T.attempts, {
      user_id: user.id, chapter_id: ch.id, phase: 'perkuat', item_id: iid, attempt_no: n, correct: ok,
      answer: body.answer, hint_level: get(hint, iid, 0), ms: Math.max(0, body.ms), version: prog.version,
    });
    const out: Json = { correct: ok, marks, attempt: n };
    if (ok) {
      const solved = { ...get(data, 'solved', {}) };
      let xp = 0;
      if (!Object.hasOwn(solved, iid)) {
        const firstTry = n === 1;
        solved[iid] = true;
        data.first_try = { ...get(data, 'first_try', {}), [iid]: firstTry };
        xp = await activity.addXp(db, user, scoring.perkuatItemXp(firstTry), `Perkuat · ${ch.title}`);
        await learning.touchMastery(db, user, ch.path_id, get(item, 'concepts', []), 2, 'Perkuat benar', mode === 'mini');
      }
      data.solved = solved;
      Object.assign(out, { xp, explain: get(item, 'explain', ''), praise: PRAISE[Object.keys(solved).length % PRAISE.length] });
      if (mode === 'phase') {
        const inserted: string[] = get(data, 'inserted', []);
        const base: string[] = data.order.filter((i: string) => !inserted.includes(i));
        await learning.setPhaseProgress(db, prog, 'perkuat', base.filter(i => Object.hasOwn(solved, i)).length / Math.max(1, base.length));
      }
    } else {
      // the ladder advances one step on a wrong answer (L3 → L4 → L5), capped by the mentor setting
      const cap = Math.min(5, assistCap(user));
      const { hints, available } = hintLevels(item, cap);
      const nxt = available.find(lvl => lvl > get(hint, iid, 0));
      if (nxt) hint[iid] = nxt;
      data.hint = hint;
      out.hint = cap >= 3 && truthy(get(hints, 'l3')) ? hints.l3 : 'Coba lihat lagi pelan-pelan.';
      out.hint_level = get(hint, iid, 0);
      out.solution_available = n >= 3 && truthy(get(item, 'l6')) && assistCap(user) >= 6;
      if (n === 2) await learning.markWeak(db, user, ch.path_id, get(item, 'concepts', []), 'perkuat', `Salah 2× di soal “${plain(or(get(item, 'label'), get(item, 'title', '')))}”.`);
      // adaptivity: first wrong answer on an item with a similar twin inserts it right after (once per item)
      const sim = get(item, 'similar_id');
      if (mode === 'phase' && truthy(sim) && n === 1 && !get(data, 'inserted_for', []).includes(iid) && !data.order.includes(sim)) {
        const twin = content_svc.find(items, sim);
        if (twin) {
          const order = [...data.order];
          order.splice(order.indexOf(iid) + 1, 0, sim);
          data.order = order;
          data.inserted = [...get(data, 'inserted', []), sim];
          data.inserted_for = [...get(data, 'inserted_for', []), iid];
          out.inserted = { ...content_svc.perkuatItemPublic(twin), similar: true };
        }
      }
    }
    await learning.saveState(db, st, data);
    await activity.recordActivity(db, user, 0);
    await db.commit();
    out.xp_week = await activity.weekXp(db, user.id);
    return out;
  }));

  app.post('/api/chapters/:chapter_id/perkuat/hint', { schema: { ...chapterParam, body: HintIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { item_id: string; ms_since_shown: number; mode: string };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [, content] = await requirePhase(db, user, ch, 'perkuat');
    const { st, data } = await perkuatState(db, user, ch, content, body.mode === 'mini' ? 'mini' : 'phase');
    const item = content_svc.find(perkuatItems(content), body.item_id);
    if (!item) fail(404, 'Soal tidak ditemukan.');
    const { hints, available } = hintLevels(item, Math.min(5, assistCap(user)));
    const hint = { ...get(data, 'hint', {}) };
    const cur = get(hint, item.id, 0);
    const nxt = available.find(lvl => lvl > cur);
    if (nxt === undefined) {
      const reached = available.filter(lvl => lvl <= cur);
      if (!reached.length) return { level: 0, text: 'Petunjuk untuk soal ini dibatasi mentormu. Coba lihat lagi pelan-pelan.', max: true };
      const level = Math.max(...reached);
      return { level, text: hints[`l${level}`], max: true };
    }
    hint[item.id] = nxt;
    data.hint = hint;
    await learning.saveState(db, st, data);
    await insert(db, T.hint_opens, { user_id: user.id, chapter_id: ch.id, item_id: item.id, level: nxt, ms_since_shown: Math.max(0, body.ms_since_shown) });
    await db.commit();
    return { level: nxt, text: hints[`l${nxt}`], max: !available.some(lvl => lvl > nxt) };
  }));

  app.post('/api/chapters/:chapter_id/perkuat/solution', { schema: { ...chapterParam, body: SolutionIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { item_id: string; mode: string };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [, content] = await requirePhase(db, user, ch, 'perkuat');
    const { st, data } = await perkuatState(db, user, ch, content, body.mode === 'mini' ? 'mini' : 'phase');
    const item = content_svc.find(perkuatItems(content), body.item_id);
    if (!item) fail(404, 'Soal tidak ditemukan.');
    if (get(get(data, 'attempts', {}), item.id, 0) < 3 || assistCap(user) < 6 || !truthy(get(item, 'l6'))) fail(403, 'Jawaban lengkap terbuka setelah 3 kali mencoba.');
    data.hint = { ...get(data, 'hint', {}), [item.id]: 6 };
    await learning.saveState(db, st, data);
    await insert(db, T.hint_opens, { user_id: user.id, chapter_id: ch.id, item_id: item.id, level: 6 });
    await db.commit();
    return { level: 6, html: item.l6 };
  }));

  app.post('/api/chapters/:chapter_id/perkuat/index', { schema: { ...chapterParam, body: IndexIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { index: number; mode: string };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [, content] = await requirePhase(db, user, ch, 'perkuat');
    const { st, data } = await perkuatState(db, user, ch, content, body.mode === 'mini' ? 'mini' : 'phase');
    data.index = Math.max(0, Math.min(body.index, get(data, 'order', []).length - 1));
    await learning.saveState(db, st, data);
    await db.commit();
    return { index: data.index };
  }));

  app.post('/api/chapters/:chapter_id/perkuat/complete', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [, content] = await requirePhase(db, user, ch, 'perkuat');
    const mode = bodyMode(req);
    const { data } = await perkuatState(db, user, ch, content, mode);
    const order: string[] = get(data, 'order', []);
    const solved = get(data, 'solved', {});
    const missing = order.filter(i => !Object.hasOwn(solved, i));
    if (missing.length) fail(409, { code: 'unfinished', message: 'Masih ada soal yang belum benar.', missing });
    const inserted: string[] = get(data, 'inserted', []);
    const base = order.filter(i => !inserted.includes(i));
    const firstTry = get(data, 'first_try', {});
    const first = base.filter(i => truthy(get(firstTry, i))).length;
    const acc = scoring.accuracyPct(first, base.length);
    const items = new Map(perkuatItems(content).map(i => [i.id, i]));
    const conceptsOf = (i: string): string[] => get(items.get(i) ?? {}, 'concepts', []);
    if (mode === 'mini') {
      await learning.touchMastery(db, user, ch.path_id, [...new Set(order.flatMap(conceptsOf))].sort(), 2, 'Perkuat mini selesai', true);
      await db.commit();
      return { mode: 'mini', accuracy: acc, first_try: first, total: base.length, xp: 0 };
    }
    // mastery: per concept, first-try accuracy ≥ 80% → Diterapkan (3), otherwise Dilatih (2)
    const per = new Map<string, boolean[]>();
    for (const i of base) for (const c of conceptsOf(i)) per.set(c, [...(per.get(c) ?? []), truthy(get(firstTry, i))]);
    for (const [c, vals] of per) await learning.touchMastery(db, user, ch.path_id, [c], sum(vals.map(Number)) / vals.length >= 0.8 ? 3 : 2, 'Perkuat selesai');
    const res = await learning.completePhase(db, user, ch, 'perkuat', acc);
    await db.commit();
    const kuis = get(content, 'kuis', {});
    return {
      ...res, accuracy: acc, first_try: first, total: base.length, xp_week: await activity.weekXp(db, user.id),
      kuis: { round: get(kuis, 'round_size', 10), pass_pct: get(kuis, 'pass_pct', 70) },
    };
  }));

  // ------------------------------------------------------------------ KUIS
  app.get('/api/chapters/:chapter_id/kuis', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'kuis');
    const tries = await count(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, user.id), eq(T.quiz_rounds.chapter_id, ch.id), eq(T.quiz_rounds.kind, 'gate'), eq(T.quiz_rounds.finished, true)));
    await db.commit();
    return {
      ...(await header(db, user, ch, prog, content)), ...kuisCfg(content), tries,
      best: get(prog.phases.kuis, 'score'), passed: prog.phases.kuis.state === 'done',
      bank: get(get(content, 'kuis', {}), 'bank', []).length, uji: ujiOptions(content),
    };
  }));

  app.post('/api/chapters/:chapter_id/kuis/rounds', { schema: { ...chapterParam, body: RoundIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { kind: string; concept: string | null };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const kind = body.kind === 'review' ? 'review' : 'gate';
    const [prog, content] = await requirePhase(db, user, ch, kind === 'gate' ? 'kuis' : 'perkuat');
    const cfg = kuisCfg(content);
    const bank: Json[] = get(get(content, 'kuis', {}), 'bank', []);
    let picked: Json[];
    if (kind === 'review') {
      const matching = bank.filter(q => get(q, 'concepts', []).includes(body.concept));
      const pool = matching.length ? matching : bank;
      picked = sample(pool, Math.min(3, pool.length));
    } else picked = sample(bank, Math.min(cfg.round_size, bank.length));
    const rnd = await insert(db, T.quiz_rounds, {
      user_id: user.id, chapter_id: ch.id, kind, version: prog.version, question_refs: picked.map(q => [ch.id, q.id]), answers: [], per_question_sec: cfg.seconds,
    });
    await db.commit();
    return { round_id: rnd.id, kind, seconds: cfg.seconds, combo_max: cfg.combo_max, pass_pct: cfg.pass_pct, questions: picked.map(content_svc.kuisQuestionPublic) };
  }));

  app.post('/api/kuis-harian/rounds', h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const pm = await learning.progressMap(db, user.id);
    const pool: [Chapter, Json][] = [];
    for (const [cid, p] of pm) {
      if (p.phases.pahami.state !== 'done') continue;
      const ch = (await getRow(db, T.chapters, cid))!;
      const content = or(await content_svc.published(db, ch, p.version), {});
      for (const q of get(get(content, 'kuis', {}), 'bank', [])) pool.push([ch, q]);
    }
    if (!pool.length) fail(409, { code: 'empty', message: 'Selesaikan Pahami di satu bab dulu untuk membuka kuis harian.' });
    const picked = sample(pool, Math.min(5, pool.length));
    const rnd = await insert(db, T.quiz_rounds, {
      user_id: user.id, chapter_id: null, kind: 'daily', question_refs: picked.map(([c, q]) => [c.id, q.id]), answers: [], per_question_sec: 20,
    });
    await db.commit();
    return {
      round_id: rnd.id, kind: 'daily', seconds: 20, combo_max: 3, pass_pct: 0,
      questions: picked.map(([, q]) => content_svc.kuisQuestionPublic(q)), xp: await activity.weekXp(db, user.id), streak: await activity.streak(db, user),
    };
  }));

  app.post('/api/kuis/rounds/:round_id/answer', { schema: { ...roundParam, body: AnswerIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { index: number; choice: number; left: number };
    const rnd = await getRound(db, user, (req.params as P).round_id);
    if (rnd.finished) fail(409, 'Ronde sudah selesai.');
    const answers = [...(rnd.answers || [])];
    if (body.index !== answers.length) fail(409, 'Urutan soal tidak sesuai.');
    const qs = await roundQuestions(db, rnd);
    const q = qs[body.index];
    if (!q) throw new RangeError('list index out of range');
    // server-side clock: seconds since the previous answer (or the round start), minus reveal/countdown grace
    const lastTs = answers.length ? new Date(answers[answers.length - 1].at) : rnd.created_at;
    const elapsed = (Date.now() - lastTs.getTime()) / 1000 - (answers.length ? 1.4 : 3.0);
    const left = Math.max(0, Math.min(body.left, rnd.per_question_sec, Math.trunc(rnd.per_question_sec - elapsed + 1)));
    const correct = body.choice === get(q, 'a') && body.choice >= 0;
    const points = correct ? scoring.kuisPoints(rnd.combo, left) : 0;
    const combo = scoring.nextCombo(rnd.combo, correct, 3);
    const chapterId = rnd.question_refs[body.index][0];
    answers.push({ qid: q.id, chapter_id: chapterId, choice: body.choice, correct, left, points, at: new Date().toISOString() });
    await save(db, T.quiz_rounds, rnd, { score: rnd.score + points, combo, best_combo: Math.max(rnd.best_combo, combo), answers });
    if (rnd.chapter_id || rnd.kind === 'daily') {
      await insert(db, T.attempts, {
        user_id: user.id, chapter_id: chapterId, phase: 'kuis', item_id: q.id, correct, answer: body.choice,
        ms: (rnd.per_question_sec - left) * 1000, version: rnd.version, attempt_no: await attemptNo(db, user, 'kuis', q.id),
      });
    }
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return { correct, answer: get(q, 'a'), points, score: rnd.score, combo: rnd.combo, best_combo: rnd.best_combo };
  }));

  app.post('/api/kuis/rounds/:round_id/finish', { schema: roundParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const rnd = await getRound(db, user, (req.params as P).round_id);
    const qs = await roundQuestions(db, rnd);
    const answers = [...(rnd.answers || [])];
    while (answers.length < qs.length) // unanswered = timeout
      answers.push({ qid: qs[answers.length].id, choice: -1, correct: false, left: 0, points: 0, at: new Date().toISOString() });
    const correct = answers.filter(a => a.correct).length;
    const pct = scoring.accuracyPct(correct, qs.length);
    let xp = 0;
    const result: Json = {};
    if (!rnd.finished) {
      await save(db, T.quiz_rounds, rnd, { finished: true, answers, pct });
      if (rnd.kind === 'daily') {
        const already = await count(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, user.id), eq(T.quiz_rounds.kind, 'daily'), eq(T.quiz_rounds.finished, true),
          sql`${T.quiz_rounds.created_at} >= ${activity.dayStart(activity.localToday())}`, sql`${T.quiz_rounds.id} <> ${rnd.id}`));
        if (!already) xp += await activity.addXp(db, user, Math.min(scoring.XP_DAILY_QUIZ_CAP, scoring.kuisXp(rnd.score)), 'Kuis harian');
        await save(db, T.quiz_rounds, rnd, { passed: true });
      } else {
        const ch = (await getRow(db, T.chapters, rnd.chapter_id))!;
        xp += await activity.addXp(db, user, scoring.kuisXp(rnd.score), `Kuis · ${ch.title}`);
        const content = or(await content_svc.published(db, ch, rnd.version), {});
        const passPct = kuisCfg(content).pass_pct;
        for (const [i, q] of qs.entries()) {
          const a = answers[i];
          if (a.correct) await learning.touchMastery(db, user, ch.path_id, get(q, 'concepts', []), pct >= 90 ? 4 : 3, 'Kuis benar', rnd.kind === 'review');
          else {
            const picked = a.choice >= 0 && a.choice < q.o.length ? q.o[a.choice] : null;
            const note = picked !== null ? `Kamu menjawab ${plain(picked)}, seharusnya ${plain(q.o[q.a])}.` : 'Waktu habis di soal ini.';
            await learning.markWeak(db, user, ch.path_id, get(q, 'concepts', []), 'kuis', note);
          }
        }
        if (rnd.kind === 'gate') {
          const prog = await learning.ensureProgress(db, user, ch);
          const wasDone = prog.phases.kuis.state === 'done';
          if (pct >= passPct) xp += (await learning.completePhase(db, user, ch, 'kuis', pct)).xp;
          else await save(db, T.chapter_progress, prog, { phases: unlock.recordKuis(prog.phases, pct, passPct)[0], updated_at: new Date() });
          await save(db, T.quiz_rounds, rnd, { passed: pct >= passPct });
          Object.assign(result, { was_done: wasDone, pass_pct: passPct, uji: ujiOptions(content) });
        } else await save(db, T.quiz_rounds, rnd, { passed: pct >= 70 });
      }
      await db.commit();
    }
    const passPct = get(result, 'pass_pct', 70);
    const review = qs.map((q, i) => {
      const a = answers[i];
      const o: Json[] = get(q, 'o', []);
      return {
        t: q.t, answer: truthy(get(q, 'o')) ? q.o[q.a] : '', e: get(q, 'e', ''), ok: a.correct,
        picked: a.choice >= 0 && a.choice < o.length ? o[a.choice] : null, trivia: truthy(get(q, 'trivia')),
      };
    });
    return {
      kind: rnd.kind, pct, correct, total: qs.length, best_combo: rnd.best_combo, score: rnd.score,
      xp, passed: Boolean(rnd.passed), pass_pct: passPct, missing: Math.max(0, passPct - pct),
      review, chapter_id: rnd.chapter_id, xp_week: await activity.weekXp(db, user.id), ...result,
    };
  }));

  // --------------------------------------------------------------- ULANGAN
  app.post('/api/chapters/:chapter_id/ulangan/start', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    let [prog, content] = await requirePhase(db, user, ch, 'uji');
    if (get(content, 'uji_mode') === 'challenge') fail(409, { code: 'mode', message: 'Bab ini memakai Challenge.', redirect: `/bab/${ch.id}/uji/challenge` });
    const ex = exam(content);
    let s = await first(db, T.exam_sessions, where(eq(T.exam_sessions.user_id, user.id), eq(T.exam_sessions.chapter_id, ch.id), sql`${T.exam_sessions.submitted_at} is null`),
      desc(T.exam_sessions.id));
    if (s && s.deadline.getTime() < Date.now() - 60_000) {
      await grade(db, user, ch, s, content); // time ran out while away: auto-submit
      await db.commit();
      prog = await learning.ensureProgress(db, user, ch); // the header shows the phase state after grading
      s = undefined;
    }
    if (!s) {
      s = await insert(db, T.exam_sessions, {
        user_id: user.id, chapter_id: ch.id, version: prog.version,
        deadline: new Date(Date.now() + get(ex, 'minutes', 30) * 60_000), answers: {}, flags: [],
      });
      await db.commit();
    }
    return { ...(await header(db, user, ch, prog, content)), session: sessionView(s, content) };
  }));

  app.put('/api/ulangan/:sid/answers', { schema: { ...sidParam, body: ExamAnswerIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { qid: string; answer: Json };
    const s = await getSession(db, user, (req.params as P).sid);
    if (s.submitted_at) fail(409, 'Ulangan sudah dikumpulkan.');
    if (Date.now() > s.deadline.getTime() + 60_000) fail(409, 'Waktu ulangan sudah habis.');
    const answers = { ...(s.answers || {}) };
    if (blank(body.answer)) delete answers[body.qid];
    else answers[body.qid] = body.answer;
    await save(db, T.exam_sessions, s, { answers });
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return { saved: true, answered: Object.keys(answers).length };
  }));

  app.put('/api/ulangan/:sid/flags', { schema: { ...sidParam, body: FlagsIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const s = await getSession(db, user, (req.params as P).sid);
    if (s.submitted_at) fail(409, 'Ulangan sudah dikumpulkan.');
    await save(db, T.exam_sessions, s, { flags: [...new Set((req.body as { flags: string[] }).flags)].sort() });
    await db.commit();
    return { flags: s.flags };
  }));

  // body: {answers} is the final sync of locally kept answers (offline)
  app.post('/api/ulangan/:sid/submit', { schema: sidParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const s = await getSession(db, user, (req.params as P).sid);
    const ch = (await getRow(db, T.chapters, s.chapter_id))!;
    const content = or(await content_svc.published(db, ch, s.version), {});
    let extra: Json = {};
    if (!s.submitted_at) {
      const late = get(req.body ?? {}, 'answers');
      if (late !== null && typeof late === 'object' && !Array.isArray(late) && truthy(late) && Date.now() <= s.deadline.getTime() + 120_000) {
        const kept = Object.fromEntries(Object.entries(late).filter(([, v]) => !blank(v)));
        await save(db, T.exam_sessions, s, { answers: { ...(s.answers || {}), ...kept } });
      }
      extra = await grade(db, user, ch, s, content);
      await db.commit();
    }
    return { ...sessionView(s, content), ...extra, xp_week: await activity.weekXp(db, user.id) };
  }));

  // ------------------------------------------------------------- CHALLENGE
  app.get('/api/chapters/:chapter_id/challenge', { schema: chapterParam }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [prog, content] = await requirePhase(db, user, ch, 'uji');
    const chal = get(content, 'challenge');
    if (!truthy(chal)) fail(404, 'Bab ini tidak punya challenge.');
    if (get(content, 'uji_mode') === 'ulangan') fail(409, { code: 'mode', message: 'Bab ini memakai Ulangan.', redirect: `/bab/${ch.id}/uji/ulangan` });
    const st = await learning.playerState(db, user, ch, 'challenge');
    await db.commit();
    const attempts = await count(db, T.attempts, where(eq(T.attempts.user_id, user.id), eq(T.attempts.chapter_id, ch.id), eq(T.attempts.phase, 'challenge')));
    return {
      ...(await header(db, user, ch, prog, content)), challenge: content_svc.challengePublic(chal),
      code: get(st.data, 'code', get(chal, 'starter', '')), attempts,
      solved: prog.phases.uji.state === 'done', mentor: await mentorName(db, user), kuis_score: get(prog.phases.kuis, 'score'),
    };
  }));

  app.put('/api/chapters/:chapter_id/challenge/draft', { schema: { ...chapterParam, body: DraftIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    await requirePhase(db, user, ch, 'uji');
    const st = await learning.playerState(db, user, ch, 'challenge');
    await learning.saveState(db, st, { ...st.data, code: cut((req.body as { code: string }).code, runner.MAX_CODE_CHARS) });
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return { saved: true };
  }));

  app.post('/api/chapters/:chapter_id/challenge/run', { schema: { ...chapterParam, body: DraftIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const ch = await getChapter(db, (req.params as P).chapter_id);
    const [res, outcome] = await runChallenge(db, user, ch, (req.body as { code: string }).code);
    return { logs: res.logs, error: res.error, results: res.results, ...outcome, xp_week: await activity.weekXp(db, user.id) };
  }));

  app.post('/api/chapters/:chapter_id/challenge/report', { schema: { ...chapterParam, body: ReportIn } }, h(async (req, _r, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { test_id: string; body: string };
    const ch = await getChapter(db, (req.params as P).chapter_id);
    await insert(db, T.content_reports, { user_id: user.id, chapter_id: ch.id, item_id: cut(body.test_id, 40), body: cut(body.body, 1000) });
    await db.commit();
    return { ok: true };
  }));

  /** Streams robot results one by one: queued → running → pass/fail (MOTION §3.6). */
  app.get('/ws/challenge/:chapter_id', { websocket: true }, (socket, req) => {
    const chapterId = Number((req.params as { chapter_id: string }).chapter_id);
    const token = req.cookies[settings.session_cookie];
    const send = (m: Json) => socket.readyState === socket.OPEN && socket.send(JSON.stringify(m));
    let queue: Promise<unknown> = withDb(async db => {
      if (!(await userFromToken(db, token))) {
        send({ type: 'error', message: 'Silakan masuk dulu.' });
        socket.close();
      }
    });
    socket.on('message', raw => {
      queue = queue.then(() => withDb(async db => {
        let msg: Json;
        try { msg = JSON.parse(raw.toString()); } catch { msg = null; }
        if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return socket.close();
        const user = await userFromToken(db, token);
        if (!user) return socket.close();
        const code = toStr(get(msg, 'code', ''));
        const ch = Number.isInteger(chapterId) ? await getRow(db, T.chapters, chapterId) : undefined;
        if (!ch) return send({ type: 'error', message: 'Bab tidak ditemukan.' });
        let res: Json, outcome: Json;
        try {
          [res, outcome] = await runChallenge(db, user, ch, code);
        } catch (e) {
          if (e instanceof HttpError) return send({ type: 'error', message: typeof e.detail === 'string' ? e.detail : get(e.detail, 'message') });
          if (e instanceof runner.RunnerUnavailable) return send({ type: 'error', message: e.message });
          throw e;
        }
        send({ type: 'queued', tests: res.results.map((r: Json) => r.id), logs: res.logs, error: res.error });
        for (const r of res.results) {
          send({ type: 'running', id: r.id });
          send({ type: 'result', ...r });
        }
        send({ type: 'done', ...outcome, xp_week: await activity.weekXp(db, user.id) });
      })).catch(e => {
        req.log.error(e);
        socket.close(1011);
      });
    });
  });
}
