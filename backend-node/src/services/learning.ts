/* Learner progress across chapters: unlocking, phase completion, XP and mastery. */
import { all, asc, Db, eq, first, get as getRow, insert, isIn, save, sql, T, where } from '../db.ts';
import { get, type Json, or, toInt, roundHalfEven, sum } from '../util.ts';
import type { Chapter, ChapterProgress, Concept, ConceptMastery, PlayerState, User } from '../schema.ts';
import * as activity from './activity.ts';
import * as content_svc from './content.ts';
import * as scoring from './scoring.ts';
import * as unlock from './unlock.ts';

export const TIER_NAMES = ['Belum', 'Dilihat', 'Dilatih', 'Diterapkan', 'Mahir', 'Dikuasai'];
export type ProgressMap = Map<number, ChapterProgress>;

// ------------------------------------------------------------- chapters
export async function pathChapters(db: Db, pathId: number): Promise<Chapter[]> {
  return all(db, T.chapters, eq(T.chapters.path_id, pathId), asc(T.chapters.position));
}

export async function progressMap(db: Db, userId: number): Promise<ProgressMap> {
  const rows = await all(db, T.chapter_progress, eq(T.chapter_progress.user_id, userId));
  return new Map(rows.map(r => [r.chapter_id, r]));
}

export async function getProgress(db: Db, user: User, chapter: Chapter): Promise<ChapterProgress | undefined> {
  return first(db, T.chapter_progress, where(eq(T.chapter_progress.user_id, user.id), eq(T.chapter_progress.chapter_id, chapter.id)));
}

const isDone = (pm: ProgressMap, chapterId: number) => Boolean(pm.get(chapterId)?.completed_at);

export async function isUnlocked(db: Db, user: User, chapter: Chapter, chapters: Chapter[] | null = null, pm: ProgressMap | null = null): Promise<boolean> {
  chapters = chapters?.length ? chapters : await pathChapters(db, chapter.path_id);
  pm = pm ?? (await progressMap(db, user.id));
  if (pm.has(chapter.id)) return true;
  const learn = chapters.filter(c => c.kind === 'chapter');
  if (chapter.kind === 'chapter') {
    const idx = learn.findIndex(c => c.id === chapter.id);
    if (idx < 0) throw new Error('chapter is not in list');
    return idx === 0 || isDone(pm, learn[idx - 1].id);
  }
  if (chapter.kind === 'project' && chapter.project_id) {
    const proj = await getRow(db, T.projects, chapter.project_id);
    const need = proj ? learn.find(c => c.number === proj.unlock_after) : undefined;
    return Boolean(need && isDone(pm, need.id));
  }
  if (chapter.kind === 'final') return learn.every(c => isDone(pm!, c.id));
  return false;
}

/** done | now | open | soon | locked (for the map and chapter lists). */
export async function nodeState(db: Db, user: User, chapter: Chapter, chapters: Chapter[], pm: ProgressMap, currentId: number | null): Promise<string> {
  if (chapter.kind === 'project' && chapter.project_id) {
    const pp = await first(db, T.project_progress, where(eq(T.project_progress.user_id, user.id), eq(T.project_progress.project_id, chapter.project_id)));
    if (pp && pp.status === 'portfolio') return 'done';
    return (await isUnlocked(db, user, chapter, chapters, pm)) ? 'open' : 'locked';
  }
  if (isDone(pm, chapter.id)) return 'done';
  if (chapter.id === currentId) return 'now';
  if (await isUnlocked(db, user, chapter, chapters, pm)) return chapter.version ? 'open' : 'soon';
  return 'locked';
}

/** The chapter "Lanjutkan" points to: the earliest started-but-unfinished one, else the next unlocked one. */
export async function currentChapter(db: Db, user: User, chapters: Chapter[], pm: ProgressMap): Promise<Chapter | null> {
  const learn = chapters.filter(c => c.kind === 'chapter');
  for (const c of learn) {
    const p = pm.get(c.id);
    if (p && !p.completed_at) return c;
  }
  for (const c of learn) if (!isDone(pm, c.id) && c.version && (await isUnlocked(db, user, c, chapters, pm))) return c;
  return null;
}

export async function ensureProgress(db: Db, user: User, chapter: Chapter): Promise<ChapterProgress> {
  return (await getProgress(db, user, chapter)) ?? insert(db, T.chapter_progress, {
    user_id: user.id, chapter_id: chapter.id, version: chapter.version || 1, phases: unlock.initialPhases(), current: 'pahami',
  });
}

/** Placement: mark a chapter done without XP (the learner already knows it). */
export async function markChapterSkipped(db: Db, user: User, chapter: Chapter): Promise<void> {
  if (!(await getProgress(db, user, chapter))) {
    await insert(db, T.chapter_progress, {
      user_id: user.id, chapter_id: chapter.id, version: chapter.version || 1, phases: unlock.allDonePhases(), current: 'uji', completed_at: new Date(),
    });
  }
  const content = or(await content_svc.published(db, chapter), {});
  await touchMastery(db, user, chapter.path_id, get(content, 'concepts', []), 1, 'penempatan awal');
}

// ------------------------------------------------------------- phases
export async function setPhaseProgress(db: Db, p: ChapterProgress, phase: string, value: number): Promise<void> {
  await save(db, T.chapter_progress, p, { phases: unlock.setProgress(p.phases, phase, value), updated_at: new Date() });
}

/** Marks a phase done, awards XP, updates mastery and unlocks what comes next.
    Idempotent: completing an already-done phase awards nothing. */
export async function completePhase(db: Db, user: User, chapter: Chapter, phase: string, score: number | null = null): Promise<Json> {
  const p = await ensureProgress(db, user, chapter);
  const already = p.phases[phase].state === 'done';
  const patch: Partial<ChapterProgress> = {};
  patch.phases = phase === 'kuis' ? unlock.recordKuis(p.phases, toInt(score || 0))[0] : unlock.complete(p.phases, phase, score);
  await save(db, T.chapter_progress, p, patch);
  let xp = 0;
  const content = or(await content_svc.published(db, chapter, p.version), {});
  if (!already) {
    xp += await activity.addXp(db, user, scoring.XP_PHASE_DONE[phase] ?? 0, `${phase} selesai · ${chapter.title}`);
    if (phase === 'pahami') await touchMastery(db, user, chapter.path_id, get(content, 'concepts', []), 1, 'Pahami selesai');
  }
  const now = new Date();
  const next: Partial<ChapterProgress> = { current: unlock.currentPhase(p.phases), phase_since: now, updated_at: now };
  // Content published mid-phase reaches the learner once the phase ends.
  if (chapter.version && p.version !== chapter.version) next.version = chapter.version;
  let chapterDone = false;
  let nextChapter: Chapter | undefined;
  if (unlock.isChapterDone(p.phases) && !p.completed_at) {
    next.completed_at = now;
    chapterDone = true;
  }
  await save(db, T.chapter_progress, p, next);
  if (chapterDone) {
    xp += await activity.addXp(db, user, scoring.XP_CHAPTER_DONE, `Bab selesai · ${chapter.title}`);
    nextChapter = await nextLearningChapter(db, chapter);
    if (nextChapter && nextChapter.version) await ensureProgress(db, user, nextChapter);
  }
  return {
    phases: p.phases, current: p.current, xp, chapter_done: chapterDone,
    next_chapter: nextChapter ? chapterRef(nextChapter) : null,
  };
}

async function nextLearningChapter(db: Db, chapter: Chapter): Promise<Chapter | undefined> {
  return first(db, T.chapters, where(eq(T.chapters.path_id, chapter.path_id), eq(T.chapters.kind, 'chapter'), sql`${T.chapters.position} > ${chapter.position}`),
    asc(T.chapters.position));
}

export function chapterRef(c: Chapter): Json {
  return { id: c.id, slug: c.slug, title: c.title, number: c.number, published: Boolean(c.version) };
}

// ------------------------------------------------------------- player state
export async function playerState(db: Db, user: User, chapter: Chapter, phase: string): Promise<PlayerState> {
  const st = await first(db, T.player_states, where(eq(T.player_states.user_id, user.id), eq(T.player_states.chapter_id, chapter.id), eq(T.player_states.phase, phase)));
  return st ?? insert(db, T.player_states, { user_id: user.id, chapter_id: chapter.id, phase, data: {} });
}

export async function saveState(db: Db, st: PlayerState, data: Json): Promise<void> {
  await save(db, T.player_states, st, { data: { ...data }, updated_at: new Date() });
}

// ------------------------------------------------------------- mastery
export async function conceptsByKey(db: Db, pathId: number, keys: string[]): Promise<Concept[]> {
  if (!keys.length) return [];
  return all(db, T.concepts, where(eq(T.concepts.path_id, pathId), isIn(T.concepts.key, keys)));
}

async function masteryRow(db: Db, user: User, concept: Concept): Promise<ConceptMastery> {
  const row = await first(db, T.concept_mastery, where(eq(T.concept_mastery.user_id, user.id), eq(T.concept_mastery.concept_id, concept.id)));
  return row ?? insert(db, T.concept_mastery, { user_id: user.id, concept_id: concept.id, tier: 0 });
}

export async function touchMastery(db: Db, user: User, pathId: number, keys: string[], minTier: number, evidence: string, clearWeak = false): Promise<void> {
  for (const c of await conceptsByKey(db, pathId, keys)) {
    const row = await masteryRow(db, user, c);
    const patch: Partial<ConceptMastery> = { last_evidence: evidence, updated_at: new Date() };
    if (row.tier < minTier) patch.tier = minTier;
    if (clearWeak && row.weak) patch.weak = false;
    await save(db, T.concept_mastery, row, patch);
  }
  await snapshotMastery(db, user, pathId);
}

export async function markWeak(db: Db, user: User, pathId: number, keys: string[], phase: string, note: string): Promise<void> {
  for (const c of await conceptsByKey(db, pathId, keys)) {
    const row = await masteryRow(db, user, c);
    await save(db, T.concept_mastery, row, { weak: true, weak_phase: phase, weak_note: note, tier: Math.max(row.tier, 1), updated_at: new Date() });
  }
  await snapshotMastery(db, user, pathId);
}

export async function chapterMasteryPct(db: Db, user: User, chapter: Chapter, keys: string[]): Promise<number> {
  const cs = await conceptsByKey(db, chapter.path_id, keys);
  if (!cs.length) return 0;
  const rows = new Map((await all(db, T.concept_mastery, where(eq(T.concept_mastery.user_id, user.id), isIn(T.concept_mastery.concept_id, cs.map(c => c.id)))))
    .map(r => [r.concept_id, r]));
  return roundHalfEven((100 * sum(cs.map(c => rows.get(c.id)?.tier ?? 0))) / (5 * cs.length));
}

/** Average mastery over the concepts of every chapter the learner has started. */
export async function overallMasteryPct(db: Db, user: User, pathId: number): Promise<number> {
  const started = [...(await progressMap(db, user.id)).values()].map(p => p.chapter_id);
  if (!started.length) return 0;
  const cs = await all(db, T.concepts, where(eq(T.concepts.path_id, pathId), isIn(T.concepts.chapter_id, started)));
  if (!cs.length) return 0;
  const rows = new Map((await all(db, T.concept_mastery, eq(T.concept_mastery.user_id, user.id))).map(r => [r.concept_id, r.tier]));
  return roundHalfEven((100 * sum(cs.map(c => rows.get(c.id) ?? 0))) / (5 * cs.length));
}

export async function snapshotMastery(db: Db, user: User, pathId: number): Promise<void> {
  const today = activity.localToday();
  const week = activity.addDays(today, -activity.weekday(today));
  const pct = await overallMasteryPct(db, user, pathId);
  const row = await first(db, T.mastery_snapshots, where(eq(T.mastery_snapshots.user_id, user.id), eq(T.mastery_snapshots.week_start, week)));
  if (!row) await insert(db, T.mastery_snapshots, { user_id: user.id, week_start: week, pct });
  else await save(db, T.mastery_snapshots, row, { pct });
}

export async function notify(db: Db, userId: number, kind: string, title: string, body = '', link = ''): Promise<void> {
  await insert(db, T.notifications, { user_id: userId, kind, title, body, link });
}
