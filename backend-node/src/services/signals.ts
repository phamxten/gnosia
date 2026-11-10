/* Mentor signals (CONCEPT §6): computed from attempts and shown as sentences.

  repeated   same item wrong ≥ 3×                         "Alex salah 4× di Perkuat · Variabel · soal susun kode"
  gate       Kuis < pass mark twice for the same chapter  "Rizky gagal gerbang Kuis Variabel dua kali (60%, 50%)"
  hints      ≥ 3 items where all hints opened within 30 s "Maya membuka semua petunjuk dalam < 30 detik…"
  stalled    no progress in the current phase > 3 days    "Bayu tidak maju dari Pahami · scene 4 selama 5 hari"
  review     challenge / project submitted                "Salsa minta review · Challenge Rapor"
*/
import { all, asc, Db, eq, first, get as getRow, isIn, sql, T, where } from '../db.ts';
import { cut, first as firstWord, get, isInt, type Json, mostCommon, or, roundHalfEven, toStr, repr, sortBy, truthy } from '../util.ts';
import type { Attempt, Chapter, HintOpen, User } from '../schema.ts';
import * as content_svc from './content.ts';
import * as unlock from './unlock.ts';

export const TYPE_LABEL: Record<string, string> = {
  choice: 'pilih jawaban', predict: 'tebak output', fill: 'lengkapi kode', parsons: 'susun kode',
  bug: 'temukan bug', slider: 'atur nilai', match: 'pasangkan',
};
const SEVERITY: Record<string, number> = { repeated: 4, gate: 3, hints: 2, stalled: 1, review: 0 };
const STALL_DAYS = 3;
const DAY_MS = 86_400_000;

export type Cache = Map<number, { ch: Chapter | undefined; content: Json }>;

export async function chContent(db: Db, cache: Cache, chapterId: number): Promise<[Chapter | undefined, Json]> {
  if (!cache.has(chapterId)) {
    const ch = await getRow(db, T.chapters, chapterId);
    cache.set(chapterId, { ch, content: ch ? or(await content_svc.published(db, ch), {}) : {} });
  }
  const c = cache.get(chapterId)!;
  return [c.ch, c.content];
}

export const plain = (s: string | null | undefined) => (s || '').replace(/<[^>]+>/g, '');
const key2 = (a: number, b: string) => JSON.stringify([a, b]);
const items = (content: Json): Json[] => get(get(content, 'perkuat', {}), 'items', []);
const maxDate = (ds: Date[]) => new Date(Math.max(...ds.map(d => d.getTime())));

export async function learnerSignals(db: Db, learner: User, cache: Cache = new Map()): Promise<Json[]> {
  const firstName = firstWord(learner.name);
  const out: Json[] = [];
  const now = Date.now();

  // repeated failure on one Perkuat item
  const wrong = new Map<string, number>();
  const lastAt = new Map<string, Date>();
  const answers = new Map<string, Json[]>();
  for (const a of await all(db, T.attempts, where(eq(T.attempts.user_id, learner.id), eq(T.attempts.phase, 'perkuat'), eq(T.attempts.correct, false)))) {
    const k = key2(a.chapter_id, a.item_id);
    wrong.set(k, (wrong.get(k) ?? 0) + 1);
    lastAt.set(k, maxDate([lastAt.get(k) ?? a.created_at, a.created_at]));
    answers.set(k, [...(answers.get(k) ?? []), a.answer]);
  }
  const solved = new Set((await all(db, T.attempts, where(eq(T.attempts.user_id, learner.id), eq(T.attempts.phase, 'perkuat'), eq(T.attempts.correct, true))))
    .map(a => key2(a.chapter_id, a.item_id)));
  for (const [k, n] of wrong) {
    if (n < 3 || solved.has(k)) continue;
    const [cid, iid] = JSON.parse(k) as [number, string];
    const [ch, content] = await chContent(db, cache, cid);
    const item = or(content_svc.find(items(content), iid), {});
    const order = items(content).filter(i => !truthy(get(i, 'adaptive'))).map(i => i.id);
    const same = new Set(answers.get(k)!.map(repr)).size === 1;
    out.push({
      kind: 'repeated', phase: 'perkuat', count: n, at: lastAt.get(k),
      html: `${firstName} salah <b>${n}×</b> di Perkuat · ${ch ? ch.title : ''} · soal ${TYPE_LABEL[get(item, 'type')] ?? 'latihan'}`,
      pattern: same ? 'jawaban yang sama setiap kali' : 'jawabannya berganti-ganti',
      chapter_id: cid, item_id: iid, item_no: order.includes(iid) ? order.indexOf(iid) + 1 : null,
      action: { label: 'Kirim bantuan', kind: 'assign' },
    });
  }

  // gate failure: Kuis below the pass mark twice for the same chapter (while still not passed)
  const fails = new Map<number, number[]>();
  const failAt = new Map<number, Date>();
  const passedCh = new Set<number>();
  const rounds = await all(db, T.quiz_rounds, where(eq(T.quiz_rounds.user_id, learner.id), eq(T.quiz_rounds.kind, 'gate'), eq(T.quiz_rounds.finished, true)),
    asc(T.quiz_rounds.created_at), asc(T.quiz_rounds.id));
  for (const r of rounds) {
    if (r.passed) passedCh.add(r.chapter_id!);
    else {
      fails.set(r.chapter_id!, [...(fails.get(r.chapter_id!) ?? []), r.pct || 0]);
      failAt.set(r.chapter_id!, r.created_at);
    }
  }
  for (const [cid, pcts] of fails) {
    if (pcts.length < 2 || passedCh.has(cid)) continue;
    const [ch, content] = await chContent(db, cache, cid);
    // the question they miss most
    const missed = new Map<string, number>();
    for (const a of await all(db, T.attempts, where(eq(T.attempts.user_id, learner.id), eq(T.attempts.chapter_id, cid), eq(T.attempts.phase, 'kuis'), eq(T.attempts.correct, false))))
      missed.set(a.item_id, (missed.get(a.item_id) ?? 0) + 1);
    const q = missed.size ? content_svc.find(get(get(content, 'kuis', {}), 'bank', []), mostCommon(missed)) : null;
    const times = pcts.length === 2 ? 'dua kali' : `${pcts.length} kali`;
    out.push({
      kind: 'gate', phase: 'kuis', count: pcts.length, at: failAt.get(cid),
      html: `${firstName} gagal gerbang <b>Kuis</b> ${ch ? ch.title : ''} ${times} (${pcts.slice(-2).map(p => `${p}%`).join(', ')})`,
      pattern: q ? `soal “${cut(plain(q.t), 48)}” selalu salah` : '',
      chapter_id: cid, action: { label: 'Buka Perkuat mini', kind: 'mini' },
    });
  }

  // hint rushing: ≥ 3 items where every hint was opened within 30 s of seeing the item
  const perItem = new Map<string, HintOpen[]>();
  for (const h of await all(db, T.hint_opens, where(eq(T.hint_opens.user_id, learner.id), sql`${T.hint_opens.created_at} >= ${new Date(now - 7 * DAY_MS)}`))) {
    const k = key2(h.chapter_id, h.item_id);
    perItem.set(k, [...(perItem.get(k) ?? []), h]);
  }
  const rushed: Date[] = [];
  for (const hs of perItem.values()) {
    const levels = new Set(hs.map(h => h.level));
    if ([3, 4, 5].every(l => levels.has(l)) && Math.max(...hs.filter(h => [3, 4, 5].includes(h.level)).map(h => h.ms_since_shown)) < 30_000)
      rushed.push(maxDate(hs.map(h => h.created_at)));
  }
  if (rushed.length >= 3 && learner.assist_cap > 3) {
    out.push({
      kind: 'hints', phase: 'perkuat', count: rushed.length, at: maxDate(rushed),
      html: `${firstName} membuka semua petunjuk dalam &lt; 30 detik di ${rushed.length} soal terakhir`,
      pattern: 'pola: melompat ke petunjuk', action: { label: 'Batasi petunjuk ke L3', kind: 'cap', value: 3 },
    });
  }

  // stalled in the current phase
  for (const p of await all(db, T.chapter_progress, where(eq(T.chapter_progress.user_id, learner.id), sql`${T.chapter_progress.completed_at} is null`))) {
    const since = p.updated_at;
    const days = Math.floor((now - since.getTime()) / DAY_MS);
    if (days <= STALL_DAYS) continue;
    const cur = unlock.currentPhase(p.phases);
    let where_ = unlock.PHASE_LABEL[cur];
    if (cur === 'pahami') {
      const st = await first(db, T.player_states, where(eq(T.player_states.user_id, learner.id), eq(T.player_states.chapter_id, p.chapter_id), eq(T.player_states.phase, 'pahami')));
      if (st && truthy(get(st.data, 'scene'))) where_ += ` · scene ${toStr(st.data.scene)}`;
    }
    out.push({
      kind: 'stalled', phase: cur, count: days, at: since,
      html: `${firstName} tidak maju dari <b>${where_}</b> selama ${days} hari`,
      pattern: `terakhir aktif ${weekdayName(learner.last_active_at ?? since)}`, chapter_id: p.chapter_id,
      action: { label: 'Kirim pengingat', kind: 'remind' },
    });
  }

  // review requests
  for (const s of await all(db, T.submissions, where(eq(T.submissions.user_id, learner.id), eq(T.submissions.status, 'pending')))) {
    out.push({
      kind: 'review', phase: s.kind === 'challenge' ? 'uji' : 'proyek', count: 1, at: s.created_at,
      html: `${firstName} minta review · ${s.kind === 'challenge' ? s.title.split('·').pop()!.trim() : s.title}`,
      pattern: `${s.tests_passed}/${s.tests_total} tes lulus`, submission_id: s.id,
      action: { label: 'Review kode', kind: 'review' },
    });
  }
  return out;
}

function weekdayName(dt: Date): string {
  const names = ['Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu', 'Minggu'];
  return names[(new Date(dt.getTime() + 7 * 3_600_000).getUTCDay() + 6) % 7];
}

/** Most in need of help first: severity, then the count, then recency. */
export function rank(signals: Json[]): Json[] {
  return sortBy(signals, s => [-SEVERITY[s.kind], -(s.count ?? 0), -s.at.getTime() / 1000]);
}

export async function phaseFunnel(db: Db, learnerIds: number[], chapterId: number): Promise<Json> {
  const counts: Record<string, number> = Object.fromEntries(unlock.PHASES.map(p => [p, 0]));
  const durations: Record<string, number[]> = Object.fromEntries(unlock.PHASES.map(p => [p, []]));
  const now = Date.now();
  for (const p of await all(db, T.chapter_progress, where(eq(T.chapter_progress.chapter_id, chapterId), isIn(T.chapter_progress.user_id, learnerIds)))) {
    if (p.completed_at) continue;
    const cur = unlock.currentPhase(p.phases);
    counts[cur] += 1;
    durations[cur].push((now - p.phase_since.getTime()) / 1000 / 86400);
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const allD = Object.values(durations).flat().sort((a, b) => a - b);
  const median = allD.length ? allD[Math.floor(allD.length / 2)] : 0;
  let pile: Json = null;
  for (const [ph, n] of Object.entries(counts)) {
    const avg = durations[ph].length ? durations[ph].reduce((a, b) => a + b, 0) / durations[ph].length : 0;
    if (total && n / total > 0.4 && avg > median) pile = { phase: ph, count: n, avg_days: roundHalfEven(avg, 1) };
  }
  return { counts, total, pile };
}

/** First-try wrong % per concept across Perkuat, Kuis and Ulangan. */
export async function hardestConcepts(db: Db, learnerIds: number[], pathId: number, limit = 4): Promise<Json[]> {
  const conceptNames = new Map((await all(db, T.concepts, eq(T.concepts.path_id, pathId))).map(c => [c.key, c.name]));
  const cache: Cache = new Map();
  const tally = new Map<string, [number, number]>();
  for (const a of await all(db, T.attempts, where(isIn(T.attempts.user_id, learnerIds), eq(T.attempts.attempt_no, 1), isIn(T.attempts.phase, ['perkuat', 'kuis', 'ulangan'])))) {
    const [, content] = await chContent(db, cache, a.chapter_id);
    for (const c of content_svc.itemConcepts(content, a.phase, a.item_id)) {
      const t = tally.get(c) ?? [0, 0];
      tally.set(c, t);
      t[1] += 1;
      if (!a.correct) t[0] += 1;
    }
  }
  const rows = [...tally].filter(([, [, n]]) => n >= 3).map(([k, [w, n]]) => ({ key: k, name: conceptNames.get(k) ?? k, pct: roundHalfEven((100 * w) / n) }));
  return sortBy(rows, r => [-r.pct]).slice(0, limit);
}

/** Wrong answers grouped per item, with identical repeats side by side and a one-line diagnosis. */
export async function wrongPatterns(db: Db, learner: User, limit = 5): Promise<Json[]> {
  const cache: Cache = new Map();
  const groups = new Map<string, Attempt[]>();
  for (const a of await all(db, T.attempts, where(eq(T.attempts.user_id, learner.id), eq(T.attempts.correct, false), isIn(T.attempts.phase, ['perkuat', 'kuis', 'ulangan'])),
    asc(T.attempts.created_at), asc(T.attempts.id))) {
    const k = JSON.stringify([a.phase, a.chapter_id, a.item_id]);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: Json[] = [];
  for (const [k, atts] of sortBy([...groups], ([, v]) => [-v.length, -v[v.length - 1].id])) {
    const [phase, cid, iid] = JSON.parse(k) as [string, number, string];
    const [ch, content] = await chContent(db, cache, cid);
    const pool: Json[] = {
      perkuat: items(content), kuis: get(get(content, 'kuis', {}), 'bank', []), ulangan: get(or(get(content, 'ulangan'), {}), 'questions', []),
    }[phase]!;
    const item = or(content_svc.find(pool, iid), {});
    const last = atts[atts.length - 1];
    const entry: Json = {
      phase, chapter: ch ? ch.title : '', chapter_id: cid, item_id: iid, count: atts.length,
      title: plain(or(get(item, 'title'), or(get(item, 't'), ''))),
      type: TYPE_LABEL[get(item, 'type', '')] ?? (phase === 'kuis' ? 'kuis' : 'ulangan'),
      same: new Set(atts.map(a => repr(a.answer))).size === 1, diagnosis: get(item, 'diagnosis', ''),
    };
    if (phase === 'perkuat' && get(item, 'type') === 'parsons') {
      const lines = new Map(get(item, 'lines', []).map((l: Json) => [toStr(l.id), l.code]));
      const answer: Json[] = get(item, 'answer', []);
      entry.correct_lines = answer.map(i => lines.get(toStr(i)) ?? '');
      entry.wrong_lines = (or(last.answer, []) as Json[]).map((i, n) => ({
        code: lines.get(toStr(i)) ?? '', bad: n < answer.length ? toStr(i) !== toStr(answer[n]) : true,
      }));
    } else if (phase === 'perkuat' && get(item, 'type') === 'bug') {
      entry.correct_lines = get(item, 'lines', []);
      entry.picked_line = last.answer;
      entry.answer_line = get(item, 'answer');
    } else if (truthy(get(item, 'o'))) {
      const ans = last.answer;
      entry.picked = isInt(ans) && Number(ans) >= 0 && Number(ans) < item.o.length ? item.o[Number(ans)] : null;
      const key = get(item, 'a', get(item, 'answer'));
      entry.answer = isInt(key) ? item.o[Number(key)] : null;
    }
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}
