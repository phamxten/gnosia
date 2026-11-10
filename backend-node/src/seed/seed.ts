/* Seed the database with the curriculum, demo accounts and a realistic class history. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { all, type Db, dropAll, eq, first, initDb, insert, save, T, where, withDb } from '../db.ts';
import { clone, type Json, pyRound } from '../py.ts';
import type { Chapter, Concept, Klass, Organization, Project, User } from '../schema.ts';
import { hashPassword } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as content_svc from '../services/content.ts';
import { snapshotMastery } from '../services/learning.ts';
import * as unlock from '../services/unlock.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const data = (name: string): Json => JSON.parse(readFileSync(join(HERE, 'data', name), 'utf8'));

const NOW = new Date();
const MIN = 60_000;
type Ago = { days?: number; hours?: number; minutes?: number };
const ago = (a: Ago | number = {}): Date => {
  const { days = 0, hours = 0, minutes = 0 } = typeof a === 'number' ? { days: a } : a;
  return new Date(NOW.getTime() - ((days * 24 + hours) * 60 + minutes) * MIN);
};
const plus = (d: Date, a: Ago): Date => new Date(d.getTime() + ((a.days ?? 0) * 24 * 60 + (a.hours ?? 0) * 60 + (a.minutes ?? 0)) * MIN);
const seconds = (d: Date, s: number) => new Date(d.getTime() + s * 1000);

/** random.Random(seed): mulberry32, so every seed run produces the same class. */
class Rng {
  constructor(private a: number) {}
  random(): number {
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  randint(a: number, b: number): number { return a + Math.floor(this.random() * (b - a + 1)); }
  uniform(a: number, b: number): number { return a + (b - a) * this.random(); }
  choice<T>(xs: T[]): T { return xs[Math.floor(this.random() * xs.length)]; }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [xs[i], xs[j]] = [xs[j], xs[i]];
    }
    return xs;
  }
  sample<T>(xs: T[], k: number): T[] { return this.shuffle([...xs]).slice(0, k); }
}
const rng = new Rng(20260927);

// ---------------------------------------------------------------- curriculum
const CUR = data('curriculum.json');
const CONCEPTS: [string, string, string, string, number, number, string[]][] = CUR.concepts; // key, name, skill, chapter slug, x, y, requires
const CHAPTERS: [number, number, string, string, string, string, string, string, number][] = CUR.chapters; // position, number, kind, slug, title, subtitle, icon, module, x
const DESCRIPTIONS: Record<string, string> = CUR.descriptions;
const PROJECT = CUR.project;
const FIRST: string[] = CUR.first, LAST: string[] = CUR.last;
const FIRST_TRY_WRONG: Record<string, number> = CUR.first_try_wrong;
const KUIS_WRONG: Record<string, number> = CUR.kuis_wrong;
const percabanganDraft = (): Json => clone(CUR.percabangan_draft);

const BAB1 = data('bab1_halo.json');
const BAB2 = data('bab2_variabel.json');
const BANK2: Json[] = BAB2.kuis.bank;
const CHALLENGE2: Json = BAB2.challenge;
const EXAM2: Json[] = BAB2.ulangan.questions;

/** A plausible wrong answer for a Perkuat item (what a learner might really pick). */
function wrongAnswer(item: Json): Json {
  const t = item.type, key = item.answer;
  if (t === 'choice' || t === 'predict') return rng.choice(item.choices.map((_: unknown, i: number) => i).filter((i: number) => i !== key));
  if (t === 'bug') {
    const others = Array.from({ length: item.lines.length }, (_, i) => i + 1).filter(i => i !== key);
    return others.includes(1) && rng.random() < 0.5 ? 1 : rng.choice(others); // "the bug is in the declaration"
  }
  if (t === 'fill') return key && key[0] === 'let' ? ['const', '='] : [...(key || [])].reverse();
  if (t === 'parsons') {
    const k = [...(key || [])];
    if (k.length >= 3) [k[1], k[2]] = [k[2], k[1]];
    return k;
  }
  if (t === 'slider') return (key || 1) - 1;
  return null;
}

class Seeder {
  ch: Record<string, Chapter> = {};
  content: Record<string, Json> = {};
  concepts: Record<string, Concept> = {};
  kuisSeen = new Map<string, number>();
  constructor(public db: Db) {}

  // --- rows
  xp(u: User, amount: number, reason: string, when: Date) {
    return insert(this.db, T.xp_events, { user_id: u.id, amount, reason, created_at: when });
  }

  async minutes(u: User, daysAgo: number, mins: number) {
    const day = activity.addDays(activity.localToday(), -daysAgo);
    const row = await first(this.db, T.daily_activity, where(eq(T.daily_activity.user_id, u.id), eq(T.daily_activity.day, day)));
    if (row) await save(this.db, T.daily_activity, row, { seconds: row.seconds + mins * 60 });
    else await insert(this.db, T.daily_activity, { user_id: u.id, day, seconds: mins * 60 });
  }

  attempt(u: User, slug: string, phase: string, item: string, correct: boolean, when: Date, o: { n?: number; answer?: Json; hint?: number; ms?: number } = {}) {
    return insert(this.db, T.attempts, {
      user_id: u.id, chapter_id: this.ch[slug].id, phase, item_id: item, attempt_no: o.n ?? 1, correct, answer: o.answer ?? null,
      hint_level: o.hint ?? 0, ms: o.ms ?? 9000, version: this.ch[slug].version, created_at: when,
    });
  }

  async mastery(u: User, key: string, tier: number, o: { weak?: boolean; phase?: string; note?: string; when?: Date } = {}) {
    const c = this.concepts[key];
    let row = await first(this.db, T.concept_mastery, where(eq(T.concept_mastery.user_id, u.id), eq(T.concept_mastery.concept_id, c.id)));
    if (!row) row = await insert(this.db, T.concept_mastery, { user_id: u.id, concept_id: c.id, tier: 0 });
    const patch: Json = { tier: Math.max(row.tier, tier), updated_at: o.when ?? NOW };
    if (o.weak) Object.assign(patch, { weak: true, weak_phase: o.phase ?? '', weak_note: o.note ?? '' });
    await save(this.db, T.concept_mastery, row, patch);
  }

  /** done_until: last phase that is done (null = nothing done, 'uji' = chapter complete). */
  async progress(u: User, slug: string, doneUntil: string | null, o: {
    current_progress?: number; started?: Date; completed?: Date | null; since?: Date; updated?: Date; scores?: Record<string, number | null>; active_min?: number;
  } = {}) {
    const started = o.started ?? NOW, scores = o.scores ?? {};
    let phases = unlock.initialPhases();
    if (doneUntil) for (const ph of unlock.PHASES.slice(0, unlock.PHASES.indexOf(doneUntil as unlock.Phase) + 1)) phases = unlock.complete(phases, ph, scores[ph] ?? null);
    const cur = unlock.currentPhase(phases);
    if (!unlock.isChapterDone(phases)) {
      phases[cur].progress = o.current_progress ?? 0.0;
      if (cur === 'kuis' && scores.kuis_best !== undefined && scores.kuis_best !== null) phases.kuis.score = scores.kuis_best;
    }
    return insert(this.db, T.chapter_progress, {
      user_id: u.id, chapter_id: this.ch[slug].id, version: this.ch[slug].version, phases, current: cur, started_at: started,
      completed_at: o.completed ?? null, phase_since: o.since ?? started, updated_at: o.updated ?? o.since ?? started, active_seconds: (o.active_min ?? 0) * 60,
    });
  }

  state(u: User, slug: string, phase: string, d: Json, when: Date) {
    return insert(this.db, T.player_states, { user_id: u.id, chapter_id: this.ch[slug].id, phase, data: d, updated_at: when });
  }

  async kuisRound(u: User, slug: string, wrong: string[], when: Date, kind = 'gate', picks: string[] | null = null) {
    const bank: Json[] = this.content[slug].kuis.bank;
    let ids: string[];
    if (picks) ids = [...picks];
    else {
      const others = bank.filter(q => !wrong.includes(q.id)).map(q => q.id);
      const uniq = [...new Set(wrong)];
      ids = [...uniq.slice(0, 10), ...rng.sample(others, 10 - Math.min(10, uniq.length))];
      rng.shuffle(ids);
    }
    const answers: Json[] = [];
    let score = 0, combo = 1, best = 1;
    for (const [i, qid] of ids.entries()) {
      const q = bank.find(x => x.id === qid)!;
      const ok = !wrong.includes(qid);
      const left = rng.randint(6, 16);
      const pts = ok ? 100 * combo + left * 5 : 0;
      score += pts;
      combo = ok ? Math.min(3, combo + 1) : 1;
      best = Math.max(best, combo);
      const choice = ok ? q.a : (q.a + 1) % q.o.length;
      answers.push({ qid, chapter_id: this.ch[slug].id, choice, correct: ok, left, points: pts, at: seconds(when, 8 * i).toISOString() });
      const k = `${u.id}:${qid}`;
      const n = (this.kuisSeen.get(k) ?? 0) + 1;
      this.kuisSeen.set(k, n);
      await this.attempt(u, slug, 'kuis', qid, ok, seconds(when, 8 * i), { n, answer: choice, ms: (20 - left) * 1000 });
    }
    const pct = pyRound((100 * answers.filter(a => a.correct).length) / answers.length);
    return insert(this.db, T.quiz_rounds, {
      user_id: u.id, chapter_id: this.ch[slug].id, kind, version: this.ch[slug].version, question_refs: ids.map(qid => [this.ch[slug].id, qid]),
      answers, score, combo, best_combo: best, finished: true, pct, passed: pct >= 70, created_at: when,
    });
  }

  /** Simulates Perkuat items [0, upto) with first-try results. Returns the PlayerState data. */
  async perkuatRun(u: User, slug: string, upto: number, when: Date, wrongFirst: Record<string, number> = {}, answers: Record<string, Json> = {}): Promise<Json> {
    const items: Json[] = this.content[slug].perkuat.items;
    const base = items.filter(i => !i.adaptive);
    const order = base.map(i => i.id);
    const d: Json = { order: [...order], index: Math.min(upto, order.length - 1), solved: {}, attempts: {}, hint: {}, first_try: {}, inserted: [], inserted_for: [] };
    let t = when;
    for (const it of base.slice(0, upto)) {
      const iid = it.id;
      const wrongs = wrongFirst[iid] ?? 0;
      for (let k = 0; k < wrongs; k++) {
        const given = Object.hasOwn(answers, iid) ? answers[iid] : wrongAnswer(it);
        await this.attempt(u, slug, 'perkuat', iid, false, t, { n: k + 1, answer: given, hint: k ? 3 : 0 });
        t = seconds(t, 40);
      }
      await this.attempt(u, slug, 'perkuat', iid, true, t, { n: wrongs + 1, answer: it.answer });
      t = seconds(t, 50);
      d.solved[iid] = true;
      d.first_try[iid] = wrongs === 0;
      d.attempts[iid] = wrongs + 1;
      if (wrongs) {
        d.hint[iid] = 3;
        const sim = it.similar_id;
        if (sim && !d.order.includes(sim)) {
          d.order.splice(d.order.indexOf(iid) + 1, 0, sim);
          d.inserted.push(sim);
          d.inserted_for.push(iid);
          await this.attempt(u, slug, 'perkuat', sim, true, t, { n: 1, answer: null });
          d.solved[sim] = true;
          d.first_try[sim] = true;
          d.attempts[sim] = 1;
        }
      }
      await this.xp(u, wrongs === 0 ? 10 : 5, `Perkuat · ${this.ch[slug].title}`, t);
    }
    const nxt = upto < base.length ? base[upto].id : base[base.length - 1].id;
    d.index = d.order.indexOf(nxt);
    return d;
  }
}

// ---------------------------------------------------------------- main
export async function run(reset = false): Promise<void> {
  await initDb();
  if (reset) {
    await dropAll();
    await initDb();
  }
  await withDb(async db => {
    if (await first(db, T.users)) {
      console.log('Database sudah berisi data. Jalankan dengan --reset untuk mengulang seed.');
      return;
    }
    await seedAll(new Seeder(db));
    await db.commit();
    console.log('Seed selesai.');
    const cfg = data('users.json');
    const shown = process.env.GNOSIA_DEMO_PASSWORD ? 'dari GNOSIA_DEMO_PASSWORD' : cfg.password;
    console.log(`Akun demo (kata sandi: ${shown}):`);
    for (const p of [...cfg.staff, ...cfg.learners]) console.log(`  ${(p.role ?? 'learner').padEnd(8)} ${p.email}`);
  });
}

async function seedAll(s: Seeder): Promise<void> {
  const db = s.db;
  const cfg = data('users.json');
  // A public deployment (e.g. behind a tunnel) sets its own demo password instead of the documented test one.
  const pw = await hashPassword(process.env.GNOSIA_DEMO_PASSWORD || cfg.password);
  const org = await insert(db, T.organizations, { name: cfg.org });
  const path = await insert(db, T.paths, { slug: 'js-dasar', title: 'JavaScript Dasar', description: 'Dari console.log sampai array. 8 bab, 1 proyek, 1 ujian akhir.' });

  // staff
  const staff: Record<string, User> = {};
  for (const p of cfg.staff)
    staff[p.role] = await insert(db, T.users, {
      email: p.email, name: p.name, password_hash: pw, role: p.role, org_id: org.id, avatar: p.avatar, title: p.title, onboarded: true, prefs: {},
      created_at: ago(120), last_active_at: ago({ hours: 1 }),
    });
  const { admin, mentor } = staff;

  // project + chapters
  const proj = await insert(db, T.projects, {
    path_id: path.id, slug: PROJECT.slug, title: PROJECT.title, number: PROJECT.number, unlock_after: PROJECT.unlock_after,
    description: PROJECT.description, milestones: PROJECT.milestones,
  });
  const contents: Record<string, Json> = { halo: BAB1, variabel: BAB2 };
  for (const [pos, num, kind, slug, title, sub, icon, module, x] of CHAPTERS) {
    const draft = slug in contents ? clone(contents[slug]) : slug === 'percabangan' ? percabanganDraft() : content_svc.emptyContent();
    let ch = await insert(db, T.chapters, {
      path_id: path.id, position: pos, number: num, kind, slug, title, subtitle: sub, icon, module_label: module, map_x: x,
      description: DESCRIPTIONS[slug] ?? '', draft: kind === 'chapter' ? draft : {}, project_id: kind === 'project' ? proj.id : null,
      status: 'draft', version: 0, updated_by: admin.id, updated_at: ago({ days: rng.randint(4, 20) }),
    });
    s.ch[slug] = ch;
    if (slug in contents) {
      const versions = slug === 'variabel' ? 3 : 1;
      for (let v = 1; v <= versions; v++)
        await insert(db, T.chapter_versions, { chapter_id: ch.id, version: v, content: clone(contents[slug]), published_by: admin.id, published_at: ago({ days: 30 - 8 * v }) });
      ch = await save(db, T.chapters, ch, { version: versions, status: 'published' });
      s.ch[slug] = ch;
      s.content[slug] = contents[slug];
    }
  }
  await save(db, T.chapters, s.ch.variabel, { updated_at: ago({ hours: 2 }) });
  await save(db, T.chapters, s.ch.percabangan, { status: 'review', updated_by: mentor.id, updated_at: ago({ days: 1, hours: 3 }) });
  for (const [key, name, skill, slug, x, y, req] of CONCEPTS)
    s.concepts[key] = await insert(db, T.concepts, { path_id: path.id, key, name, skill, chapter_id: s.ch[slug].id, x, y, requires: req });

  // classes
  const today = activity.localToday();
  const xii = await insert(db, T.classes, { org_id: org.id, name: 'XII RPL', path_id: path.id, mentor_id: mentor.id, started_on: activity.addDays(today, -(5 * 7 + 2)) });
  const xi = await insert(db, T.classes, { org_id: org.id, name: 'XI RPL 1', path_id: path.id, mentor_id: mentor.id, started_on: activity.addDays(today, -7) });

  const people: Record<string, User> = {};
  for (const p of cfg.learners)
    people[p.story] = await insert(db, T.users, {
      email: p.email, name: p.name, password_hash: pw, role: 'learner', org_id: org.id, class_id: xii.id, avatar: p.avatar, onboarded: true, goal: 'sekolah',
      daily_goal_min: 20, prefs: { nosi: true, reminders: true, mentor_sees_wrong: true, language: 'id' },
      created_at: ago({ days: 46 + rng.randint(0, 6) }), last_active_at: ago({ hours: 3 }),
    });
  await storyNadia(s, people.nadia, mentor);
  await storyAlex(s, people.alex, mentor);
  await storyRizky(s, people.rizky);
  await storyMaya(s, people.maya);
  await storyBayu(s, people.bayu);
  await storySalsa(s, people.salsa, mentor, proj);
  await genericClass(s, xii, 26, pw, org);
  await genericClass(s, xi, 4, pw, org, true);
  // learner reports on the Papan Skor output test (admin content flag)
  const learners = await all(db, T.users, eq(T.users.role, 'learner'));
  for (const u of learners.filter(x => x.class_id === xii.id).slice(0, 4))
    await insert(db, T.content_reports, {
      user_id: u.id, chapter_id: s.ch.variabel.id, item_id: 't4', body: 'Output sudah Garuda: 6 tapi tes gagal (ada spasi di akhir).', created_at: ago({ days: rng.randint(1, 5) }),
    });
  for (const u of learners) await snapshotMastery(db, u, path.id);
}

async function finishBab1(s: Seeder, u: User, startDays: number, mentor: User | null = null, o: { kuis_wrong?: string[]; perkuat_wrong?: Record<string, number>; approve?: boolean } = {}) {
  const approve = o.approve ?? true;
  const t0 = ago({ days: startDays });
  await s.state(u, 'halo', 'pahami', { scene: 6, max_scene: 6 }, plus(t0, { minutes: 6 }));
  await s.xp(u, 50, 'pahami selesai · Halo, JavaScript', plus(t0, { minutes: 6 }));
  const d = await s.perkuatRun(u, 'halo', 7, plus(t0, { minutes: 8 }), o.perkuat_wrong ?? {});
  await s.state(u, 'halo', 'perkuat', d, plus(t0, { minutes: 16 }));
  await s.xp(u, 75, 'perkuat selesai · Halo, JavaScript', plus(t0, { minutes: 16 }));
  const first_ = d.order.filter((i: string) => !d.inserted.includes(i) && d.first_try[i]).length;
  const acc = pyRound((100 * first_) / 7);
  const r = await s.kuisRound(u, 'halo', o.kuis_wrong ?? [], plus(t0, { days: 1 }));
  await s.xp(u, Math.floor(r.score / 20), 'Kuis · Halo, JavaScript', plus(t0, { days: 1 }));
  await s.xp(u, 60, 'kuis selesai · Halo, JavaScript', plus(t0, { days: 1 }));
  const code = '// Kartu perkenalan Nosi\nconsole.log("Halo, aku Nosi");\nconsole.log(2025 - 2010);\n';
  await s.attempt(u, 'halo', 'challenge', 'challenge', false, plus(t0, { days: 1, minutes: 10 }), { n: 1, answer: { code: code.replace('2025 - 2010', '15'), passed: 3, total: 4, error: null } });
  await s.attempt(u, 'halo', 'challenge', 'challenge', true, plus(t0, { days: 1, minutes: 14 }), { n: 2, answer: { code, passed: 4, total: 4, error: null } });
  const doneAt = plus(t0, { days: 1, minutes: 14 });
  await s.xp(u, 180, 'Bab selesai · Halo, JavaScript', doneAt);
  await s.progress(u, 'halo', 'uji', { started: t0, completed: doneAt, scores: { perkuat: acc, kuis: r.pct, uji: 100 }, active_min: rng.randint(24, 36) });
  await insert(s.db, T.submissions, {
    user_id: u.id, kind: 'challenge', chapter_id: s.ch.halo.id, title: 'Challenge · Bab 1 · Kartu perkenalan', filename: 'kenalan.js', code, attempt_no: 2,
    tests_passed: 4, tests_total: 4, status: approve ? 'approved' : 'pending', reviewed_by: mentor && approve ? mentor.id : null,
    reviewed_at: approve ? plus(doneAt, { hours: 5 }) : null, created_at: doneAt,
  });
  if (approve && mentor) await s.xp(u, 30, 'Challenge disetujui mentor', plus(doneAt, { hours: 5 }));
  for (const k of ['consolelog', 'urutan']) await s.mastery(u, k, 5, { when: doneAt });
  await s.mastery(u, 'komentar', 4, { when: doneAt });
  for (const w of o.kuis_wrong ?? []) {
    const q = s.content.halo.kuis.bank.find((x: Json) => x.id === w);
    for (const k of q.concepts ?? []) await s.mastery(u, k, 3, { weak: true, phase: 'kuis', note: `Kamu menjawab ${q.o[(q.a + 1) % q.o.length]}, seharusnya ${q.o[q.a]}.`, when: doneAt });
  }
}

async function bab2Pahami(s: Seeder, u: User, start: Date) {
  await s.state(u, 'variabel', 'pahami', { scene: 7, max_scene: 7 }, plus(start, { minutes: 7 }));
  await s.xp(u, 50, 'pahami selesai · Variabel', plus(start, { minutes: 7 }));
  for (const k of ['let', 'assign', 'const', 'hitung', 'penamaan', 'salinan']) await s.mastery(u, k, 1, { when: start });
}

const touch = (s: Seeder, u: User, when: Date) => save(s.db, T.users, u, { last_active_at: when });

async function storyNadia(s: Seeder, u: User, mentor: User) {
  await touch(s, u, ago({ minutes: 12 }));
  await finishBab1(s, u, 20, mentor, { kuis_wrong: ['h12'], perkuat_wrong: { b4: 1 } });
  const start = ago({ days: 5, hours: 4 });
  await bab2Pahami(s, u, start);
  const t = ago({ hours: 20 });
  const d = await s.perkuatRun(u, 'variabel', 3, t, { q2: 2 }, { q2: ['const', '='] });
  await s.state(u, 'variabel', 'perkuat', d, ago({ minutes: 12 }));
  await s.progress(u, 'variabel', 'pahami', { current_progress: 0.375, started: start, since: plus(start, { minutes: 7 }), updated: ago({ minutes: 12 }), active_min: 19 });
  await s.mastery(u, 'let', 2, { weak: true, phase: 'perkuat', note: 'Salah 2× di soal “Lengkapi umur”. Kotak mana yang digembok?', when: ago({ hours: 19 }) });
  await s.mastery(u, 'const', 2, { weak: true, phase: 'perkuat', note: 'Salah 2× di soal “Lengkapi umur”. Kotak mana yang digembok?', when: ago({ hours: 19 }) });
  await s.mastery(u, 'assign', 2);
  await s.mastery(u, 'hitung', 2);
  // 12-day streak (goal 20 min), 15 minutes so far today
  for (let day = 1; day < 13; day++) await s.minutes(u, day, rng.randint(21, 34));
  for (let day = 15; day < 30; day++) await s.minutes(u, day, rng.randint(8, 30));
  await s.minutes(u, 0, 15);
  for (let day = 1; day < 6; day++) await s.xp(u, 20, 'Kuis harian', ago({ days: day, hours: 2 }));
  const weeks = [14, 19, 24, 29, 33, 39, 46];
  const today = activity.localToday();
  const monday = activity.addDays(today, -activity.weekday(today));
  for (const [i, pct] of weeks.entries()) await insert(s.db, T.mastery_snapshots, { user_id: u.id, week_start: activity.addDays(monday, -7 * (7 - i)), pct });
  await insert(s.db, T.messages, {
    learner_id: u.id, author_id: mentor.id, context: 'Challenge Kartu perkenalan', read: false, created_at: ago({ hours: 2 }),
    body: 'Bagus, output kartu kenalanmu rapi sekali dan umurnya dihitung, bukan diketik. Coba tantangan bonus: tambah baris ketiga berisi hobimu.',
  });
  await insert(s.db, T.notifications, { user_id: u.id, kind: 'message', title: 'Pesan dari Dimas', body: 'Bagus, output kartu kenalanmu rapi sekali…', link: '/beranda', created_at: ago({ hours: 2 }) });
  await insert(s.db, T.notebooks, {
    user_id: u.id, title: 'Coretan uang saku', attached_chapter_id: s.ch.variabel.id, created_at: ago({ days: 3 }), updated_at: ago({ days: 1 }),
    cells: [
      { id: 'n1', type: 'note', src: 'Minggu ini aku mau hitung sisa uang saku setelah jajan. Pakai <b>variabel</b> dari Bab 2.' },
      { id: 'c1', type: 'code', src: 'const uangSaku = 50000;\nlet jajan = 12000 + 8000;\nlet sisa = uangSaku - jajan;\nconsole.log("Sisa:", sisa);' },
      { id: 'c2', type: 'code', src: 'const hari = ["Sen", "Sel", "Rab"];\nfor (const h of hari) {\n  console.log(h, "hemat", sisa / 3);\n}' },
      { id: 'c3', type: 'code', src: '// sengaja salah ketik untuk lihat diagnostik\nconsole.log("Total jajan:", jajn);' },
    ],
  });
  await insert(s.db, T.notebooks, { user_id: u.id, title: 'Eksperimen string', created_at: ago({ days: 9 }), updated_at: ago({ days: 8 }), cells: [{ id: 'c1', type: 'code', src: 'console.log("Halo" + " " + "Nadia");' }] });
  await insert(s.db, T.notebooks, {
    user_id: u.id, title: 'Tebak angka (game)', created_at: ago({ days: 12 }), updated_at: ago({ days: 11 }),
    cells: [{ id: 'c1', type: 'code', src: 'const rahasia = 7;\nconsole.log("Tebakan 5 benar?", 5 === rahasia);' }],
  });
}

async function storyAlex(s: Seeder, u: User, mentor: User) {
  await touch(s, u, ago({ hours: 2 }));
  await finishBab1(s, u, 16, mentor, { kuis_wrong: ['h8', 'h13'] });
  const start = ago({ days: 4 });
  await bab2Pahami(s, u, start);
  const d = await s.perkuatRun(u, 'variabel', 3, ago({ days: 1 }), { q1: 1 });
  const wrongOrder = ['1', '3', '2', '4'];
  for (let k = 0; k < 4; k++) await s.attempt(u, 'variabel', 'perkuat', 'q4', false, ago({ hours: 2, minutes: 40 - 9 * k }), { n: k + 1, answer: wrongOrder, hint: Math.min(5, 3 + k) });
  d.attempts.q4 = 4;
  d.hint.q4 = 5;
  d.index = d.order.indexOf('q4');
  d.order.splice(d.order.indexOf('q4') + 1, 0, 'q4b');
  d.inserted.push('q4b');
  d.inserted_for.push('q4');
  await s.state(u, 'variabel', 'perkuat', d, ago({ hours: 2, minutes: 13 }));
  await s.progress(u, 'variabel', 'pahami', { current_progress: 0.25, started: start, since: plus(start, { minutes: 9 }), updated: ago({ hours: 2 }), active_min: 26 });
  await s.mastery(u, 'hitung', 2, { weak: true, phase: 'perkuat', note: 'Salah 4× di soal “Susun total belanja”.' });
  await s.mastery(u, 'let', 2);
  await s.mastery(u, 'const', 4);
  for (let day = 0; day < 9; day++) await s.minutes(u, day, rng.randint(10, 30));
}

async function storyRizky(s: Seeder, u: User) {
  await touch(s, u, ago({ days: 1, hours: 3 }));
  await finishBab1(s, u, 18, null, { kuis_wrong: ['h3', 'h9'] });
  const start = ago({ days: 6 });
  await bab2Pahami(s, u, start);
  const d = await s.perkuatRun(u, 'variabel', 8, ago({ days: 4 }), { q5: 1, q3: 1 });
  await s.state(u, 'variabel', 'perkuat', d, ago({ days: 3 }));
  await s.xp(u, 75, 'perkuat selesai · Variabel', ago({ days: 3 }));
  const r1 = await s.kuisRound(u, 'variabel', ['k9', 'k2', 'k16', 'k19'], ago({ days: 2, hours: 5 }));
  const r2 = await s.kuisRound(u, 'variabel', ['k9', 'k5', 'k13', 'k19', 'k6'], ago({ days: 1, hours: 4 }));
  for (const r of [r1, r2]) await s.xp(u, Math.floor(r.score / 20), 'Kuis · Variabel', r.created_at);
  await s.progress(u, 'variabel', 'perkuat', { current_progress: 0.5, started: start, since: ago({ days: 3 }), updated: ago({ days: 1, hours: 4 }), scores: { perkuat: 75, kuis_best: 60 }, active_min: 34 });
  await s.mastery(u, 'salinan', 2, { weak: true, phase: 'kuis', note: 'Kamu menjawab 5, seharusnya 2.' });
  await s.mastery(u, 'const', 3);
  await s.mastery(u, 'let', 3);
  for (let day = 1; day < 7; day++) await s.minutes(u, day, rng.randint(12, 28));
}

async function storyMaya(s: Seeder, u: User) {
  await touch(s, u, ago({ hours: 1 }));
  await finishBab1(s, u, 14, null, { kuis_wrong: ['h20'] });
  const start = ago({ days: 3 });
  await bab2Pahami(s, u, start);
  const d = await s.perkuatRun(u, 'variabel', 6, ago({ hours: 5 }));
  for (const [iid, baseMin] of [['q4', 70], ['q5', 50], ['q6', 30]] as const) {
    for (const [lvl, ms] of [[3, 6000], [4, 11000], [5, 17000]] as const)
      await insert(s.db, T.hint_opens, { user_id: u.id, chapter_id: s.ch.variabel.id, item_id: iid, level: lvl, ms_since_shown: ms + rng.randint(0, 5000), created_at: ago({ minutes: baseMin - lvl }) });
    d.hint[iid] = 5;
  }
  await s.state(u, 'variabel', 'perkuat', d, ago({ hours: 1 }));
  await s.progress(u, 'variabel', 'pahami', { current_progress: 0.75, started: start, since: plus(start, { minutes: 8 }), updated: ago({ hours: 1 }), active_min: 22 });
  for (let day = 0; day < 5; day++) await s.minutes(u, day, rng.randint(15, 30));
}

async function storyBayu(s: Seeder, u: User) {
  await touch(s, u, ago({ days: 5, hours: 2 }));
  await finishBab1(s, u, 25, null, { kuis_wrong: ['h4', 'h12', 'h17'], perkuat_wrong: { b3: 2, b5: 1 } });
  const start = ago({ days: 7 });
  await s.state(u, 'variabel', 'pahami', { scene: 4, max_scene: 4 }, ago({ days: 5, hours: 2 }));
  await s.progress(u, 'variabel', null, { current_progress: pyRound(3 / 7, 3), started: start, since: start, updated: ago({ days: 5, hours: 2 }), active_min: 9 });
  for (const k of ['let', 'assign']) await s.mastery(u, k, 1);
  for (const day of [5, 7, 8, 11]) await s.minutes(u, day, rng.randint(8, 22));
}

async function storySalsa(s: Seeder, u: User, mentor: User, proj: Project) {
  await touch(s, u, ago({ hours: 1 }));
  await finishBab1(s, u, 22, mentor);
  const start = ago({ days: 9 });
  await bab2Pahami(s, u, start);
  const d = await s.perkuatRun(u, 'variabel', 8, ago({ days: 7 }), { q5: 1 });
  await s.state(u, 'variabel', 'perkuat', d, ago({ days: 6 }));
  await s.xp(u, 75, 'perkuat selesai · Variabel', ago({ days: 6 }));
  const r = await s.kuisRound(u, 'variabel', ['k15'], ago({ days: 4 }));
  await s.xp(u, Math.floor(r.score / 20) + 60, 'Kuis · Variabel', ago({ days: 4 }));
  const bug = CHALLENGE2.starter + 'const namaTim = "Garuda";\nconst skor = 0;\n\nskor = skor + 3;\nskor = skor + 3;\n\nconsole.log(namaTim + ": " + skor);\n';
  const good = '// Papan skor lomba\nconst namaTim = "Garuda";\nlet skor = 0;\n\nskor = skor + 3;\nskor = skor + 3;\n\nconsole.log(namaTim + ": " + skor);\n';
  await s.attempt(u, 'variabel', 'challenge', 'challenge', false, ago({ days: 1, hours: 2 }), { n: 1, answer: { code: bug, passed: 1, total: 4, error: null } });
  await s.attempt(u, 'variabel', 'challenge', 'challenge', true, ago({ days: 1, hours: 1 }), { n: 2, answer: { code: good, passed: 4, total: 4, error: null } });
  await s.state(u, 'variabel', 'challenge', { code: good }, ago({ days: 1, hours: 1 }));
  await s.xp(u, 180, 'Bab selesai · Variabel', ago({ days: 1, hours: 1 }));
  await s.progress(u, 'variabel', 'uji', { started: start, completed: ago({ days: 1, hours: 1 }), scores: { perkuat: 88, kuis: r.pct, uji: 100 }, active_min: 33 });
  await insert(s.db, T.submissions, {
    user_id: u.id, kind: 'challenge', chapter_id: s.ch.variabel.id, title: 'Challenge · Bab 2 · Papan skor lomba', filename: 'papan-skor.js', code: good,
    attempt_no: 2, tests_passed: 4, tests_total: 4, status: 'pending', created_at: ago({ days: 1, hours: 1 }),
  });
  for (const [k, t] of [['let', 5], ['const', 5], ['assign', 4], ['hitung', 4], ['penamaan', 4], ['salinan', 4]] as const) await s.mastery(u, k, t);
  const msCode = '// Milestone 1 · data uang saku\nconst uangSaku = 100000;\nconst jajanSenin = 15000;\nconst jajanSelasa = 30000;\nconst jajanRabu = 12000;\nconsole.log("Uang saku:", uangSaku);\n';
  await insert(s.db, T.project_progress, {
    user_id: u.id, project_id: proj.id, milestone: 0, code: msCode, status: 'waiting', updated_at: ago({ hours: 1 }),
    last_run: {
      results: [{ id: 'm1a', pass: true, detail: '', ms: 2 }, { id: 'm1b', pass: true, detail: '', ms: 1 }, { id: 'm1c', pass: true, detail: '', ms: 1 }],
      logs: ['Uang saku: 100000'], error: null,
    },
  });
  await insert(s.db, T.submissions, {
    user_id: u.id, kind: 'milestone', project_id: proj.id, milestone: 0, title: 'Proyek · Kalkulator Uang Saku · milestone 1', filename: 'uang-saku.js',
    code: msCode, attempt_no: 1, tests_passed: 3, tests_total: 3, status: 'pending', created_at: ago({ hours: 1 }),
  });
  await insert(s.db, T.messages, {
    learner_id: u.id, author_id: u.id, project_id: proj.id, context: 'Proyek Kalkulator Uang Saku', read: true, created_at: ago({ hours: 1 }),
    body: 'Kak, milestone 1 sudah. Nama variabel jajannya sudah jelas belum?',
  });
  for (let day = 0; day < 14; day++) await s.minutes(u, day, rng.randint(20, 40));
}

async function genericClass(s: Seeder, klass: Klass, n: number, pw: string, org: Organization, onlyBab1 = false) {
  const plan = onlyBab1 ? Array<string>(n).fill('bab1')
    : [...Array(3).fill('bab1'), ...Array(4).fill('pahami'), ...Array(11).fill('perkuat'), ...Array(4).fill('kuis'), ...Array(3).fill('uji'), 'done'];
  const used = new Set<string>();
  for (const [i, where_] of plan.slice(0, n).entries()) {
    let name: string;
    do name = `${rng.choice(FIRST)} ${rng.choice(LAST)}`; while (used.has(name));
    used.add(name);
    const email = name.toLowerCase().replace(/ /g, '.') + '@smksig.sch.id';
    let u = await insert(s.db, T.users, {
      email, name, password_hash: pw, role: 'learner', org_id: org.id, class_id: klass.id, avatar: rng.choice(['', 'a2', 'a3', 'a4', 'a5']), onboarded: true,
      goal: 'sekolah', daily_goal_min: rng.choice([10, 20, 20, 30]), prefs: { nosi: true, reminders: true, mentor_sees_wrong: true, language: 'id' },
      created_at: ago({ days: 40 + rng.randint(0, 8) }),
    });
    const stalled = (where_ === 'perkuat' || where_ === 'bab1') && i % 7 === 3;
    const last = stalled ? ago({ days: rng.randint(8, 9) }) : ago({ hours: rng.randint(1, 40) });
    u = await save(s.db, T.users, u, { last_active_at: last });
    for (let day = 0; day < 9; day++) if (rng.random() < 0.75 && ago({ days: day }).getTime() <= last.getTime() + 3_600_000) await s.minutes(u, day, rng.randint(8, 35));
    if (where_ === 'bab1') {
      const t = stalled ? last : ago({ days: rng.randint(3, 9) });
      await s.state(u, 'halo', 'pahami', { scene: 6, max_scene: 6 }, t);
      const d = await s.perkuatRun(u, 'halo', rng.randint(1, 5), t);
      await s.state(u, 'halo', 'perkuat', d, t);
      await s.progress(u, 'halo', 'pahami', { current_progress: Object.keys(d.solved).length / 7, started: plus(t, { days: -1 }), since: t, updated: last });
      await s.mastery(u, 'consolelog', 2);
      continue;
    }
    await finishBab1(s, u, rng.randint(12, 24), null, {
      kuis_wrong: rng.sample(['h3', 'h8', 'h12', 'h14', 'h20'], rng.randint(0, 2)),
      perkuat_wrong: Object.fromEntries(rng.sample(['b3', 'b4', 'b5'], rng.randint(0, 2)).map(k => [k, 1])),
    });
    const start = ago({ days: rng.randint(5, 9) });
    if (where_ === 'pahami') {
      const scene = rng.randint(2, 6);
      await s.state(u, 'variabel', 'pahami', { scene, max_scene: scene }, last);
      await s.progress(u, 'variabel', null, { current_progress: (scene - 1) / 7, started: start, since: ago({ days: rng.uniform(0.5, 2) }), updated: last });
      await s.mastery(u, 'let', 1);
      continue;
    }
    await bab2Pahami(s, u, start);
    const wrong: Record<string, number> = Object.fromEntries(Object.entries(FIRST_TRY_WRONG).filter(([, p]) => rng.random() < p).map(([k]) => [k, 1]));
    if (where_ === 'perkuat') {
      const upto = rng.randint(2, 7);
      const d = await s.perkuatRun(u, 'variabel', upto, ago({ days: rng.randint(1, 3) }), { ...wrong });
      await s.state(u, 'variabel', 'perkuat', d, last);
      const since = !stalled ? ago({ days: rng.uniform(2.5, 4.5) }) : ago({ days: 9 });
      await s.progress(u, 'variabel', 'pahami', { current_progress: upto / 8, started: start, since, updated: last });
      for (const k of ['let', 'const', 'assign']) await s.mastery(u, k, 2, { weak: rng.random() < 0.25, phase: 'perkuat', note: 'Salah 2× di soal “temukan bug const”.' });
      continue;
    }
    const d = await s.perkuatRun(u, 'variabel', 8, plus(start, { days: 1 }), wrong);
    await s.state(u, 'variabel', 'perkuat', d, plus(start, { days: 1 }));
    const acc = pyRound((100 * Object.keys(d.first_try).filter(i => d.first_try[i] && !d.inserted.includes(i)).length) / 8);
    await s.xp(u, 75, 'perkuat selesai · Variabel', plus(start, { days: 1 }));
    const misses = Object.entries(KUIS_WRONG).filter(([, p]) => rng.random() < p).map(([k]) => k).slice(0, 3);
    const rounds: Json[] = [];
    if (where_ === 'kuis' || rng.random() < 0.3) {
      const filler = rng.sample(BANK2.filter(q => !misses.includes(q.id) && !q.trivia).map(q => q.id), 5);
      rounds.push(await s.kuisRound(u, 'variabel', [...misses, ...filler].slice(0, 5), plus(start, { days: 2 }))); // 50%: not passed
    }
    if (where_ === 'uji' || where_ === 'done') rounds.push(await s.kuisRound(u, 'variabel', misses, plus(start, { days: 2, hours: 3 })));
    for (const r of rounds) await s.xp(u, Math.floor(r.score / 20), 'Kuis · Variabel', r.created_at);
    const best = rounds.length ? Math.max(...rounds.map(r => r.pct)) : null;
    if (where_ === 'kuis') {
      await s.progress(u, 'variabel', 'perkuat', { current_progress: (best || 0) / 100, started: start, since: ago({ days: rng.uniform(0.5, 1.8) }), updated: last, scores: { perkuat: acc, kuis_best: best } });
      for (const k of ['let', 'const', 'assign', 'hitung']) await s.mastery(u, k, 3);
      if (misses.includes('k9')) await s.mastery(u, 'salinan', 2, { weak: true, phase: 'kuis', note: 'Kamu menjawab 5, seharusnya 2.' });
      continue;
    }
    await s.xp(u, 60, 'kuis selesai · Variabel', plus(start, { days: 2, hours: 3 }));
    if (where_ === 'uji') {
      await s.state(u, 'variabel', 'challenge', { code: CHALLENGE2.starter + 'const namaTim = "Garuda";\n' }, last);
      await s.progress(u, 'variabel', 'kuis', { current_progress: 0.2, started: start, since: ago({ days: rng.uniform(0.3, 1.5) }), updated: last, scores: { perkuat: acc, kuis: best } });
      for (const k of ['let', 'const', 'assign', 'hitung', 'penamaan']) await s.mastery(u, k, 3);
      continue;
    }
    const doneAt = plus(start, { days: 3 });
    await s.progress(u, 'variabel', 'uji', { started: start, completed: doneAt, scores: { perkuat: acc, kuis: best, uji: 85 }, active_min: rng.randint(26, 38) });
    await examDone(u, s, doneAt);
    await s.xp(u, 180, 'Bab selesai · Variabel', doneAt);
    for (const k of ['let', 'const', 'assign', 'hitung', 'penamaan', 'salinan']) await s.mastery(u, k, 4);
  }
}

async function examDone(u: User, s: Seeder, when: Date) {
  const rows: Json[] = [];
  for (const [i, q] of EXAM2.entries()) {
    const ok = q.id !== 'u4';
    rows.push({ n: i + 1, label: q.label, ok, pts: ok ? q.pts : 0, max: q.pts, note: ok ? '' : 'Kamu menjawab 5, seharusnya 2. Konsep ini ditambahkan ke <b>Perlu diulang</b>.' });
    await s.attempt(u, 'variabel', 'ulangan', q.id, ok, when, { n: 1, answer: q.answer });
  }
  return insert(s.db, T.exam_sessions, {
    user_id: u.id, chapter_id: s.ch.variabel.id, version: s.ch.variabel.version, started_at: plus(when, { minutes: -19 }), deadline: plus(when, { minutes: 11 }),
    answers: {}, flags: [], submitted_at: when, score: 90, passed: true, results: rows,
  });
}
