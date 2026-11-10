/* Per-chapter unlock state machine (INFORMATION-ARCHITECTURE §1, CONCEPT §3).

    pahami:open  --complete-->                 pahami:done  + perkuat:open
    perkuat:open --all items correct once-->   perkuat:done + kuis:open
    kuis:open    --round >= pass_pct-->        kuis:done    + uji:open   (below pass: stays open)
    uji:open     --exam passed / all tests-->  uji:done  -> chapter done -> next chapter pahami:open

Pure functions over the `phases` object so they are trivially testable. */
import { clone, pyRound } from '../py.ts';

export const PHASES = ['pahami', 'perkuat', 'kuis', 'uji'] as const;
export type Phase = (typeof PHASES)[number];
export const PHASE_LABEL: Record<string, string> = { pahami: 'Pahami', perkuat: 'Perkuat', kuis: 'Kuis', uji: 'Uji' };
export const KUIS_PASS_PCT = 70;

export type Phases = Record<string, { state: string; progress: number; score?: number | null; [k: string]: any }>;

export function initialPhases(): Phases {
  return Object.fromEntries(PHASES.map(p => [p, { state: p === 'pahami' ? 'open' : 'locked', progress: 0.0 }]));
}

export function allDonePhases(): Phases {
  return Object.fromEntries(PHASES.map(p => [p, { state: 'done', progress: 1.0 }]));
}

/** The phase the "Lanjutkan" button opens: the first one not done (or uji if all done). */
export function currentPhase(phases: Phases): Phase {
  for (const p of PHASES) if (phases[p].state !== 'done') return p;
  return 'uji';
}

export function isOpen(phases: Phases, phase: string): boolean {
  return ['open', 'done'].includes(phases[phase].state);
}

export function isChapterDone(phases: Phases): boolean {
  return PHASES.every(p => phases[p].state === 'done');
}

export function setProgress(phases: Phases, phase: string, progress: number): Phases {
  const out = clone(phases);
  if (out[phase].state === 'open') out[phase].progress = Math.max(0.0, Math.min(1.0, pyRound(progress, 3)));
  return out;
}

/** Mark `phase` done and open the next one. Throws if the phase is still locked. */
export function complete(phases: Phases, phase: string, score: number | null = null): Phases {
  if (phases[phase].state === 'locked') throw new Error(`${phase} masih terkunci`);
  const out = clone(phases);
  out[phase].state = 'done';
  out[phase].progress = 1.0;
  if (score !== null && score !== undefined) out[phase].score = score;
  const idx = PHASES.indexOf(phase as Phase);
  if (idx + 1 < PHASES.length) {
    const nxt = PHASES[idx + 1];
    if (out[nxt].state === 'locked') out[nxt].state = 'open';
  }
  return out;
}

/** Apply a finished gate round. Returns [phases, passed]. Failing keeps Kuis open with the best score. */
export function recordKuis(phases: Phases, pct: number, passPct = KUIS_PASS_PCT): [Phases, boolean] {
  const passed = pct >= passPct;
  if (passed) {
    const best = Math.max(pct, phases.kuis.score || 0);
    return [complete(phases, 'kuis', best), true];
  }
  const out = clone(phases);
  if (out.kuis.state !== 'done') {
    out.kuis.score = Math.max(pct, out.kuis.score || 0);
    out.kuis.progress = pyRound(pct / 100, 3);
  }
  return [out, false];
}

/** Values for the 4-arc PhaseRing (done = 1, open = progress, locked = 0). */
export function ringValues(phases: Phases): number[] {
  return PHASES.map(p => {
    const st = phases[p];
    return st.state === 'done' ? 1.0 : st.state === 'open' ? Number(st.progress || 0) : 0.0;
  });
}

export function doneCount(phases: Phases): number {
  return PHASES.filter(p => phases[p].state === 'done').length;
}
