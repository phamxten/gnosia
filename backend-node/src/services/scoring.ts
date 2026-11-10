/* Scores and XP (CONCEPT §3.3, §5). XP is never removed. */
import { roundHalfEven } from '../util.ts';

export const KUIS_COMBO_MAX = 3;
export const KUIS_POINTS_BASE = 100;
export const KUIS_POINTS_PER_SECOND = 5;

export const XP_PERKUAT_FIRST_TRY = 10;
export const XP_PERKUAT_RETRY = 5;
export const XP_PHASE_DONE: Record<string, number> = { pahami: 50, perkuat: 75, kuis: 60 };
export const XP_CHAPTER_DONE = 180;
export const XP_KUIS_FAIL_CONSOLATION = 0; // the round's score/20 is still granted
export const XP_CHALLENGE_APPROVED = 30;
export const XP_DAILY_QUIZ_CAP = 20;

/** Points for one correct answer: 100 × combo + remainingSeconds × 5. */
export function kuisPoints(combo: number, secondsLeft: number): number {
  return KUIS_POINTS_BASE * combo + Math.max(0, secondsLeft) * KUIS_POINTS_PER_SECOND;
}

/** Combo starts ×1, +1 per correct answer up to the max, resets on wrong/timeout. */
export function nextCombo(combo: number, correct: boolean, comboMax = KUIS_COMBO_MAX): number {
  if (!correct) return 1;
  return Math.min(comboMax, combo + 1);
}

export function kuisXp(score: number): number {
  return Math.floor(score / 20);
}

export function accuracyPct(correct: number, total: number): number {
  return total ? roundHalfEven((100 * correct) / total) : 0;
}

export function perkuatItemXp(firstTry: boolean): number {
  return firstTry ? XP_PERKUAT_FIRST_TRY : XP_PERKUAT_RETRY;
}
