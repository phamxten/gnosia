/* Admin: curriculum dashboard with data-driven content flags, people, and the Builder API. */
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { all, asc, type Db, desc, eq, first, get as getRow, insert, isIn, save, sql, T, where } from '../db.ts';
import { dict, fail, int, model, oneOf, optional, params, str } from '../http.ts';
import { deepEqual, first as firstWord, get, isInt, type Json, or, pyRound, pyStr, repr, sortBy, truthy } from '../py.ts';
import type { Chapter, User } from '../schema.ts';
import { hashPassword, requireRole } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as content_svc from '../services/content.ts';
import * as unlock from '../services/unlock.ts';
import { ago, person } from '../views.ts';
import { h } from './common.ts';

const adminOnly = (req: FastifyRequest, db: Db) => requireRole(req, db, 'admin');
const staff = (req: FastifyRequest, db: Db) => requireRole(req, db, 'admin', 'mentor');
const DAY_MS = 86_400_000;
const plain = (s: string | null | undefined) => (s || '').replace(/<[^>]+>/g, '');

function summary(content: Json): string {
  const c = content_svc.phaseCounts(content);
  const parts: string[] = [];
  if (c.scenes) parts.push(`${c.scenes} scene`);
  if (c.items) parts.push(`${c.items} soal`);
  if (c.bank) parts.push(`${c.bank} kuis`);
  const uji = ([['ulangan', c.exam], ['challenge', get(content, 'challenge')]] as [string, unknown][]).filter(([, ok]) => truthy(ok)).map(([x]) => x);
  if (uji.length) parts.push(uji.join(' + '));
  return parts.join(' · ') || 'kosong';
}

async function contentOf(db: Db, ch: Chapter): Promise<Json> {
  return or(await content_svc.published(db, ch), or(ch.draft, {}));
}

async function overview(db: Db, me: User): Promise<Json> {
  const today = activity.localToday();
  const learners = await all(db, T.users, eq(T.users.role, 'learner'));
  const ids = learners.map(u => u.id);
  const spark: number[] = [];
  for (let i = 0; i < 8; i++) {
    const d = activity.addDays(today, -(7 - i));
    spark.push((await db.q.select({ n: sql<number>`count(*)::int` }).from(T.daily_activity).where(where(eq(T.daily_activity.day, d), sql`${T.daily_activity.seconds} > 0`)))[0].n);
  }
  const weekAgo = Date.now() - 7 * DAY_MS;
  const active = learners.filter(u => u.last_active_at && u.last_active_at.getTime() >= weekAgo).length;
  const chapters = await all(db, T.chapters, eq(T.chapters.kind, 'chapter'), asc(T.chapters.position));
  const published = chapters.filter(c => c.version);
  // gate pass on first try: the first gate round of each learner per chapter
  const firstRounds = new Map<string, { passed: boolean | null }>();
  for (const r of await all(db, T.quiz_rounds, where(eq(T.quiz_rounds.kind, 'gate'), eq(T.quiz_rounds.finished, true)), asc(T.quiz_rounds.created_at), asc(T.quiz_rounds.id))) {
    const k = `${r.user_id}:${r.chapter_id}`;
    if (!firstRounds.has(k)) firstRounds.set(k, r);
  }
  const gate = firstRounds.size ? pyRound((100 * [...firstRounds.values()].filter(r => r.passed).length) / firstRounds.size) : 0;
  const done = await all(db, T.chapter_progress, where(sql`${T.chapter_progress.completed_at} is not null`, sql`${T.chapter_progress.active_seconds} > 0`));
  const avgMin = done.length ? pyRound(done.reduce((a, p) => a + p.active_seconds, 0) / done.length / 60) : 0;
  const dist: Record<string, number> = Object.fromEntries(unlock.PHASES.map(p => [p, 0]));
  for (const p of await all(db, T.chapter_progress, where(sql`${T.chapter_progress.completed_at} is null`, isIn(T.chapter_progress.user_id, ids))))
    dist[unlock.currentPhase(p.phases)] += 1;
  let itemsTotal = 0;
  for (const c of published) {
    const k = content_svc.phaseCounts(or(await content_svc.published(db, c), {}));
    itemsTotal += k.items + k.similar + k.bank + k.exam;
  }
  const recent = await db.q.select().from(T.chapters).orderBy(desc(T.chapters.updated_at), asc(T.chapters.id)).limit(6);
  const inReview = chapters.filter(c => c.status === 'review').length;
  return {
    org: me.org_id ? (await getRow(db, T.organizations, me.org_id))!.name : '',
    kpis: { active, spark, published: published.length, chapters: chapters.length, review: inReview, gate_first_try: gate, avg_minutes: avgMin },
    flags: await contentFlags(db),
    distribution: dist,
    status: { published: published.length, items: itemsTotal, review: inReview, draft: chapters.filter(c => !c.version).length },
    recent: await Promise.all(recent.map(async c => ({
      id: c.id, title: c.kind === 'chapter' ? `${c.number} · ${c.title}` : c.title, path: (await getRow(db, T.paths, c.path_id))!.title,
      summary: summary(await contentOf(db, c)), status: c.status, kind: c.kind,
      by: c.updated_by ? firstWord((await getRow(db, T.users, c.updated_by))!.name) : 'sistem', ago: ago(c.updated_at),
    }))),
  };
}

type Stats = Record<string, { n: number; wrong_pct: number }>;

async function itemStats(db: Db, chapterId: number, phase: string): Promise<Stats> {
  const tally = new Map<string, [number, number]>();
  const rows = await db.q.select({ item_id: T.attempts.item_id, correct: T.attempts.correct }).from(T.attempts)
    .where(where(eq(T.attempts.chapter_id, chapterId), eq(T.attempts.phase, phase), eq(T.attempts.attempt_no, 1)));
  for (const r of rows) {
    const t = tally.get(r.item_id) ?? [0, 0];
    tally.set(r.item_id, t);
    t[1] += 1;
    if (!r.correct) t[0] += 1;
  }
  return Object.fromEntries([...tally].map(([k, [w, n]]) => [k, { n, wrong_pct: pyRound((100 * w) / n) }]));
}

async function contentFlags(db: Db, limit = 6): Promise<Json[]> {
  const flags: Json[] = [];
  for (const ch of await all(db, T.chapters, sql`${T.chapters.version} > 0`)) {
    const content = or(await content_svc.published(db, ch), {});
    const items: Json[] = get(get(content, 'perkuat', {}), 'items', []);
    // Perkuat: first-try wrong % far above the chapter average
    const stats = await itemStats(db, ch.id, 'perkuat');
    const vals = Object.values(stats);
    if (vals.length) {
      const avg = vals.reduce((a, s) => a + s.wrong_pct, 0) / vals.length;
      for (const [iid, s] of Object.entries(stats)) {
        if (s.n >= 5 && s.wrong_pct >= Math.max(40, avg * 1.8)) {
          const item = or(content_svc.find(items, iid), {});
          const order = items.filter(i => !truthy(get(i, 'adaptive'))).map(i => i.id);
          const num = order.includes(iid) ? order.indexOf(iid) + 1 : 'serupa';
          flags.push({
            phase: 'perkuat', icon: get(item, 'type') === 'bug' ? 'bug' : 'list-checks', score: s.wrong_pct,
            title: `Perkuat · ${ch.title} · soal ${num} “${or(get(item, 'label'), plain(get(item, 'title', '')))}”`,
            reason: `${s.wrong_pct}% salah di percobaan 1, jauh di atas rata-rata ${pyRound(avg)}%. Mungkin instruksinya ambigu.`,
            href: `/admin/bab/${ch.id}?edit=item:${iid}`,
          });
        }
      }
    }
    // Pahami: learners stuck on one scene for more than 2 days
    const stuck = new Map<number, number>();
    let started = 0;
    const cutoff = Date.now() - 2 * DAY_MS;
    for (const st of await all(db, T.player_states, where(eq(T.player_states.chapter_id, ch.id), eq(T.player_states.phase, 'pahami')))) {
      started += 1;
      const prog = await first(db, T.chapter_progress, where(eq(T.chapter_progress.user_id, st.user_id), eq(T.chapter_progress.chapter_id, ch.id)));
      if (prog && prog.phases.pahami.state !== 'done' && st.updated_at.getTime() < cutoff) {
        const scene = Math.trunc(Number(get(st.data, 'scene', 1)));
        stuck.set(scene, (stuck.get(scene) ?? 0) + 1);
      }
    }
    for (const [scene, n] of stuck) {
      if (started >= 4 && n / started >= 0.25) {
        flags.push({
          phase: 'pahami', icon: 'clapperboard', score: pyRound((100 * n) / started), title: `Pahami · ${ch.title} · scene ${scene}`,
          reason: `${pyRound((100 * n) / started)}% siswa berhenti di scene ini lebih dari 2 hari.`, href: `/admin/bab/${ch.id}?edit=scene:${scene}`,
        });
      }
    }
    // Kuis: questions almost nobody gets right
    for (const [qid, s] of Object.entries(await itemStats(db, ch.id, 'kuis'))) {
      if (s.n >= 5 && 100 - s.wrong_pct <= 20) {
        const q = or(content_svc.find(get(get(content, 'kuis', {}), 'bank', []), qid), {});
        const reason = truthy(get(q, 'trivia')) ? 'Terlalu sulit untuk trivia; pertimbangkan pindah ke Perkuat.' : 'Hampir semua siswa salah. Cek kunci jawaban dan pilihan pengecohnya.';
        flags.push({
          phase: 'kuis', icon: 'zap', score: s.wrong_pct, title: `Kuis · ${ch.title} · soal “${plain(get(q, 't', qid)).slice(0, 40)}”`,
          reason: `${s.wrong_pct}% salah. ${reason}`, href: `/admin/bab/${ch.id}?edit=kuis`,
        });
      }
    }
    // Challenge: learner reports on a test
    const reports = await db.q.select({ item_id: T.content_reports.item_id, n: sql<number>`count(*)::int` }).from(T.content_reports)
      .where(eq(T.content_reports.chapter_id, ch.id)).groupBy(T.content_reports.item_id);
    for (const { item_id, n } of reports) {
      if (n >= 3) {
        const tests: Json[] = get(or(get(content, 'challenge'), {}), 'tests', []);
        const idx = tests.findIndex(t => t.id === item_id);
        flags.push({
          phase: 'uji', icon: 'flask-conical', score: 50 + n,
          title: `Challenge · ${get(or(get(content, 'challenge'), {}), 'title', ch.title)} · tes #${idx >= 0 ? idx + 1 : '?'}`,
          reason: `${n} laporan “output benar tapi gagal”. Cek aturan pembanding tes ini.`, href: `/admin/bab/${ch.id}?edit=challenge`,
        });
      }
    }
  }
  return sortBy(flags, f => [-f.score]).slice(0, limit);
}

async function sceneStats(db: Db, ch: Chapter): Promise<Json> {
  const reached = new Map<number, number>();
  let total = 0;
  for (const st of await all(db, T.player_states, where(eq(T.player_states.chapter_id, ch.id), eq(T.player_states.phase, 'pahami')))) {
    total += 1;
    const prog = await first(db, T.chapter_progress, where(eq(T.chapter_progress.user_id, st.user_id), eq(T.chapter_progress.chapter_id, ch.id)));
    if (prog && prog.phases.pahami.state !== 'done') {
      const scene = Math.trunc(Number(get(st.data, 'scene', 1)));
      reached.set(scene, (reached.get(scene) ?? 0) + 1);
    }
  }
  return Object.fromEntries([...reached].map(([k, v]) => [String(k), { stopped_pct: total ? pyRound((100 * v) / total) : 0 }]));
}

/** For BugPick items: which wrong line learners pick most (for the data insight callout). */
async function wrongLineStats(db: Db, ch: Chapter, draft: Json): Promise<Json> {
  const out: Record<string, Record<string, number>> = {};
  const bugs = get(get(draft, 'perkuat', {}), 'items', []).filter((i: Json) => get(i, 'type') === 'bug').map((i: Json) => i.id);
  const rows = await db.q.select({ item_id: T.attempts.item_id, answer: T.attempts.answer }).from(T.attempts)
    .where(where(eq(T.attempts.chapter_id, ch.id), eq(T.attempts.phase, 'perkuat'), eq(T.attempts.correct, false), isIn(T.attempts.item_id, bugs)));
  for (const { item_id, answer } of rows) {
    if (answer === null) continue;
    const d = (out[item_id] ??= {});
    d[pyStr(answer)] = (d[pyStr(answer)] ?? 0) + 1;
  }
  return out;
}

/** Problems that block publishing. */
export function validate(c: Json): string[] {
  const p: string[] = [];
  const scenes: Json[] = get(get(c, 'pahami', {}), 'scenes', []);
  if (!scenes.length) p.push('Pahami belum punya scene.');
  scenes.forEach((s, i) => { if (!truthy(get(s, 'title'))) p.push(`Scene ${i + 1} belum punya judul.`); });
  const items: Json[] = get(get(c, 'perkuat', {}), 'items', []);
  const ids = items.map(i => get(i, 'id'));
  if (ids.length !== new Set(ids.map(repr)).size) p.push('Ada ID soal Perkuat yang kembar.');
  if (items.filter(i => !truthy(get(i, 'adaptive'))).length < 1) p.push('Perkuat belum punya soal.');
  items.forEach((it, idx) => {
    const n = idx + 1;
    const t = get(it, 'type');
    const ans = get(it, 'answer');
    if (t === 'choice' || t === 'predict') {
      const ch = get(it, 'choices');
      if (!truthy(ch) || !isInt(ans) || !(Number(ans) >= 0 && Number(ans) < ch.length)) p.push(`Soal Perkuat ${n}: pilihan atau kunci jawaban belum lengkap.`);
    } else if (t === 'bug') {
      const lines = get(it, 'lines');
      if (!truthy(lines) || !isInt(ans) || !(Number(ans) >= 1 && Number(ans) <= lines.length)) p.push(`Soal Perkuat ${n}: tandai baris yang error.`);
    } else if (t === 'fill') {
      if ((get(it, 'code', '').split('{{slot}}').length - 1) !== get(it, 'answer', []).length) p.push(`Soal Perkuat ${n}: jumlah kotak kosong tidak sama dengan jawaban.`);
    } else if (t === 'parsons') {
      const a = get(it, 'answer', []).map(pyStr).sort();
      const b = get(it, 'lines', []).map((line: Json) => pyStr(get(line, 'id'))).sort();
      if (!deepEqual(a, b)) p.push(`Soal Perkuat ${n}: urutan jawaban harus memakai semua baris.`);
    }
    if (truthy(get(it, 'similar_id')) && !ids.some(i => deepEqual(i, it.similar_id))) p.push(`Soal Perkuat ${n}: soal serupa yang ditautkan tidak ada.`);
  });
  const k = or(get(c, 'kuis'), {});
  const bank: Json[] = get(k, 'bank', []);
  if (bank.length < get(k, 'round_size', 10)) p.push(`Bank Kuis butuh minimal ${get(k, 'round_size', 10)} soal (sekarang ${bank.length}).`);
  bank.forEach((q, i) => {
    const o: Json[] = get(q, 'o', []);
    if (o.length < 2 || !isInt(get(q, 'a')) || !(q.a >= 0 && q.a < o.length)) p.push(`Soal Kuis ${i + 1}: pilihan atau kunci belum lengkap.`);
  });
  const mode = get(c, 'uji_mode', 'any');
  const hasExam = truthy(get(or(get(c, 'ulangan'), {}), 'questions'));
  const hasCh = truthy(get(c, 'challenge'));
  if (!hasExam && !hasCh) p.push('Uji butuh Ulangan atau Challenge.');
  if (mode === 'ulangan' && !hasExam) p.push('Mode Uji = Ulangan, tapi ulangan kosong.');
  if (mode === 'challenge' && !hasCh) p.push('Mode Uji = Challenge, tapi challenge kosong.');
  if (hasCh && !truthy(get(c.challenge, 'tests'))) p.push('Challenge belum punya tes.');
  return p;
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const UsersQuery = model({ role: optional(str()), q: str({ default: '' }) });
const UserIn = model({ name: str({ minLength: 1 }), email: str(), password: str({ minLength: 1 }), role: str({ default: 'learner' }), class_id: optional(int()) });
const UserPatch = model({ role: optional(str()), class_id: optional(int()) });
const ClassIn = model({ name: str({ minLength: 1 }), mentor_id: optional(int()) });
const NewChapter = model({ title: str({ minLength: 1 }), subtitle: str({ default: '' }), icon: str({ default: 'box' }) });
const DraftIn = model({ draft: dict(), title: optional(str()), subtitle: optional(str()), description: optional(str()), icon: optional(str()) });
const StatusIn = model({ status: str() });
const ConceptIn = model({ key: str({ minLength: 1, maxLength: 60 }), name: str({ minLength: 1, maxLength: 80 }), chapter_id: optional(int()) });
const cidParam = { params: params(['cid']) };

async function chapterOr404(db: Db, cid: number): Promise<Chapter> {
  const ch = await getRow(db, T.chapters, cid);
  if (!ch) fail(404, 'Bab tidak ditemukan.');
  return ch;
}

const firstPath = (db: Db) => first(db, T.paths, undefined, asc(T.paths.id));

export default function admin(app: FastifyInstance) {
  app.get('/api/admin/overview', h(async (req, _r, db) => overview(db, await adminOnly(req, db))));

  app.get('/api/admin/counts', h(async (req, _r, db) => {
    await staff(req, db);
    const chapters = await all(db, T.chapters);
    const tot = { chapters: chapters.filter(c => c.kind === 'chapter').length, perkuat: 0, kuis: 0, challenge: 0, ulangan: 0, proyek: 0 };
    for (const c of chapters) {
      const cc = or(c.draft, {});
      tot.perkuat += get(get(cc, 'perkuat', {}), 'items', []).length;
      tot.kuis += get(get(cc, 'kuis', {}), 'bank', []).length;
      tot.challenge += truthy(get(cc, 'challenge')) ? 1 : 0;
      tot.ulangan += truthy(get(or(get(cc, 'ulangan'), {}), 'questions')) ? 1 : 0;
      tot.proyek += c.kind === 'project' ? 1 : 0;
    }
    return tot;
  }));

  app.get('/api/admin/export', h(async (req, reply, db) => {
    await adminOnly(req, db);
    const lines = [['nama', 'email', 'kelas', 'bab', 'fase', 'pahami', 'perkuat', 'kuis', 'uji', 'selesai', 'menit aktif', 'xp total']];
    for (const u of await all(db, T.users, eq(T.users.role, 'learner'), asc(T.users.name), asc(T.users.id))) {
      const klass = u.class_id ? await getRow(db, T.classes, u.class_id) : undefined;
      const xp = await activity.totalXp(db, u.id);
      for (const p of await all(db, T.chapter_progress, eq(T.chapter_progress.user_id, u.id))) {
        const ch = (await getRow(db, T.chapters, p.chapter_id))!;
        lines.push([
          u.name, u.email, klass ? klass.name : '', `${ch.number} · ${ch.title}`, unlock.currentPhase(p.phases),
          ...unlock.PHASES.map(ph => p.phases[ph].state + (get(p.phases[ph], 'score') !== null ? ` ${pyRound(p.phases[ph].score!)}` : '')),
          p.completed_at ? 'ya' : '', String(Math.floor(p.active_seconds / 60)), String(xp),
        ]);
      }
    }
    reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="gnosia-progres.csv"');
    return Buffer.from('﻿' + lines.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n', 'utf8');
  }));

  // ------------------------------------------------------------------ people
  app.get('/api/admin/users', { schema: { querystring: UsersQuery } }, h(async (req, _r, db) => {
    await adminOnly(req, db);
    const { role, q } = req.query as { role: string | null; q: string };
    const rows = (await all(db, T.users, role ? eq(T.users.role, role) : undefined, asc(T.users.role), asc(T.users.name), asc(T.users.id)))
      .filter(u => !q || (u.name + u.email).toLowerCase().includes(q.toLowerCase()));
    const items: Json[] = [];
    for (const u of rows)
      items.push({ ...person(u)!, email: u.email, class: u.class_id ? (await getRow(db, T.classes, u.class_id))!.name : '', active: ago(u.last_active_at), xp: await activity.totalXp(db, u.id) });
    const classes: Json[] = [];
    for (const k of await all(db, T.classes, undefined, asc(T.classes.name), asc(T.classes.id)))
      classes.push({ id: k.id, name: k.name, mentor: k.mentor_id ? person(await getRow(db, T.users, k.mentor_id)) : null });
    return { items, classes };
  }));

  app.post('/api/admin/users', { schema: { body: UserIn } }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const body = req.body as { name: string; email: string; password: string; role: string; class_id: number | null };
    if (!['learner', 'mentor', 'admin'].includes(body.role)) fail(422, 'Peran tidak dikenal.');
    if (await first(db, T.users, sql`lower(${T.users.email}) = ${body.email.toLowerCase()}`)) fail(422, { fields: { email: 'Email sudah terdaftar.' } });
    const u = await insert(db, T.users, {
      name: body.name.trim(), email: body.email.trim().toLowerCase(), password_hash: await hashPassword(body.password), role: body.role,
      org_id: me.org_id, class_id: body.class_id, onboarded: body.role !== 'learner', prefs: {},
    });
    await db.commit();
    return person(u);
  }));

  app.patch('/api/admin/users/:uid', { schema: { params: params(['uid']), body: UserPatch } }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const body = req.body as { role: string | null; class_id: number | null };
    const u = await getRow(db, T.users, (req.params as { uid: number }).uid);
    if (!u) fail(404, 'Pengguna tidak ditemukan.');
    const patch: Partial<User> = {};
    if (body.role && ['learner', 'mentor', 'admin'].includes(body.role)) {
      if (u.id === me.id && body.role !== 'admin') fail(409, 'Kamu tidak bisa menurunkan peranmu sendiri.');
      patch.role = body.role;
    }
    if (body.class_id !== null) patch.class_id = body.class_id || null;
    if (Object.keys(patch).length) await save(db, T.users, u, patch);
    await db.commit();
    return person(u);
  }));

  app.post('/api/admin/classes', { schema: { body: ClassIn } }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const body = req.body as { name: string; mentor_id: number | null };
    const path = await firstPath(db);
    const k = await insert(db, T.classes, { org_id: me.org_id!, name: body.name.trim(), path_id: path ? path.id : null, mentor_id: body.mentor_id, started_on: activity.localToday() });
    await db.commit();
    return { id: k.id, name: k.name };
  }));

  // ------------------------------------------------------------------ builder
  app.get('/api/admin/chapters', h(async (req, _r, db) => {
    await staff(req, db);
    const out: Json[] = [];
    for (const c of await all(db, T.chapters, undefined, asc(T.chapters.path_id), asc(T.chapters.position), asc(T.chapters.id)))
      out.push({
        id: c.id, number: c.number, kind: c.kind, title: c.title, status: c.status, version: c.version,
        path: (await getRow(db, T.paths, c.path_id))!.title, summary: summary(or(c.draft, {})), ago: ago(c.updated_at),
      });
    return out;
  }));

  app.post('/api/admin/chapters', { schema: { body: NewChapter } }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const body = req.body as { title: string; subtitle: string; icon: string };
    const path = (await firstPath(db))!;
    const agg = (await db.q.select({ pos: sql<number>`coalesce(max(${T.chapters.position}), 0)::int`, num: sql<number>`coalesce(max(${T.chapters.number}), 0)::int` })
      .from(T.chapters).where(eq(T.chapters.path_id, path.id)))[0];
    const last = agg.pos, num = agg.num + 1;
    let slug = body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `bab-${num}`;
    while (await first(db, T.chapters, where(eq(T.chapters.path_id, path.id), eq(T.chapters.slug, slug)))) slug += '-baru';
    const ch = await insert(db, T.chapters, {
      path_id: path.id, position: last + 1, number: num, kind: 'chapter', slug, title: body.title.trim(), subtitle: body.subtitle, icon: body.icon,
      map_x: last % 2 ? 50 : 36, status: 'draft', version: 0, draft: content_svc.emptyContent(), updated_by: me.id,
    });
    await db.commit();
    return { id: ch.id };
  }));

  app.get('/api/admin/chapters/:cid', { schema: cidParam }, h(async (req, _r, db) => {
    await staff(req, db);
    const ch = await chapterOr404(db, (req.params as { cid: number }).cid);
    const draft = truthy(ch.draft) ? ch.draft : content_svc.emptyContent();
    return {
      id: ch.id, kind: ch.kind, number: ch.number, title: ch.title, subtitle: ch.subtitle, description: ch.description,
      icon: ch.icon, status: ch.status, version: ch.version, path: (await getRow(db, T.paths, ch.path_id))!.title,
      draft, draft_saved: ch.draft_saved_at ? ago(ch.draft_saved_at) : null,
      dirty: Boolean(ch.version) && !deepEqual(await content_svc.published(db, ch), draft),
      stats: {
        perkuat: await itemStats(db, ch.id, 'perkuat'), kuis: await itemStats(db, ch.id, 'kuis'), scenes: await sceneStats(db, ch),
        wrong_lines: await wrongLineStats(db, ch, draft),
      },
      concepts: (await all(db, T.concepts, eq(T.concepts.path_id, ch.path_id))).map(c => ({ key: c.key, name: c.name })),
      problems: validate(draft),
    };
  }));

  app.put('/api/admin/chapters/:cid/draft', { schema: { ...cidParam, body: DraftIn } }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const body = req.body as { draft: Json; title: string | null; subtitle: string | null; description: string | null; icon: string | null };
    const ch = await chapterOr404(db, (req.params as { cid: number }).cid);
    const patch: Partial<Chapter> = { draft: body.draft };
    for (const f of ['title', 'subtitle', 'description', 'icon'] as const) if (body[f] !== null) patch[f] = body[f]!;
    const now = new Date();
    await save(db, T.chapters, ch, { ...patch, draft_saved_at: now, updated_at: now, updated_by: me.id });
    await db.commit();
    return { saved: true, problems: validate(ch.draft), next_version: ch.version + 1 };
  }));

  app.post('/api/admin/chapters/:cid/publish', { schema: cidParam }, h(async (req, _r, db) => {
    const me = await adminOnly(req, db);
    const ch = await chapterOr404(db, (req.params as { cid: number }).cid);
    const problems = validate(or(ch.draft, {}));
    if (problems.length) fail(422, { message: 'Belum bisa diterbitkan.', problems });
    const version = ch.version + 1;
    await save(db, T.chapters, ch, { version, status: 'published', updated_at: new Date(), updated_by: me.id });
    await insert(db, T.chapter_versions, { chapter_id: ch.id, version, content: content_svc.clone(ch.draft), published_by: me.id });
    // make sure concepts referenced by the content exist on the constellation
    for (const key of get(ch.draft, 'concepts', [])) {
      if (!(await first(db, T.concepts, where(eq(T.concepts.path_id, ch.path_id), eq(T.concepts.key, key)))))
        await insert(db, T.concepts, { path_id: ch.path_id, key, name: key, chapter_id: ch.id, x: 100 + 60 * ch.number, y: 240 });
    }
    await db.commit();
    return { version: ch.version, status: ch.status };
  }));

  app.post('/api/admin/chapters/:cid/status', { schema: { ...cidParam, body: StatusIn } }, h(async (req, _r, db) => {
    await staff(req, db);
    const status = (req.body as { status: string }).status;
    const ch = await chapterOr404(db, (req.params as { cid: number }).cid);
    if (!['draft', 'review'].includes(status)) fail(422, 'Status tidak dikenal.');
    await save(db, T.chapters, ch, { status: !ch.version || status === 'review' ? status : 'published' });
    await db.commit();
    return { status: ch.status };
  }));

  app.post('/api/admin/concepts', { schema: { body: ConceptIn } }, h(async (req, _r, db) => {
    await adminOnly(req, db);
    const body = req.body as { key: string; name: string; chapter_id: number | null };
    const path = (await firstPath(db))!;
    if (await first(db, T.concepts, where(eq(T.concepts.path_id, path.id), eq(T.concepts.key, body.key)))) fail(422, 'Kunci konsep sudah ada.');
    const c = await insert(db, T.concepts, { path_id: path.id, key: body.key, name: body.name, chapter_id: body.chapter_id, x: 500, y: 240 });
    await db.commit();
    return { key: c.key, name: c.name };
  }));
}
