/* Pure domain rules: unlock state machine, Kuis scoring, XP, diagnostics. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as diagnostics from '../src/services/diagnostics.ts';
import * as scoring from '../src/services/scoring.ts';
import * as unlock from '../src/services/unlock.ts';

test('initial: only pahami open', () => {
  const p = unlock.initialPhases();
  assert.deepEqual(unlock.PHASES.map(x => p[x].state), ['open', 'locked', 'locked', 'locked']);
  assert.equal(unlock.currentPhase(p), 'pahami');
});

test('phases unlock in order', () => {
  let p = unlock.complete(unlock.initialPhases(), 'pahami');
  assert.ok(p.perkuat.state === 'open' && p.kuis.state === 'locked');
  p = unlock.complete(p, 'perkuat', 88);
  assert.equal(p.kuis.state, 'open');
  assert.throws(() => unlock.complete(unlock.initialPhases(), 'kuis'));
});

test('kuis gate needs 70 percent', () => {
  let p = unlock.complete(unlock.complete(unlock.initialPhases(), 'pahami'), 'perkuat');
  let passed: boolean;
  [p, passed] = unlock.recordKuis(p, 60);
  assert.ok(!passed && p.kuis.state === 'open' && p.uji.state === 'locked' && p.kuis.score === 60);
  [p, passed] = unlock.recordKuis(p, 70);
  assert.ok(passed && p.kuis.state === 'done' && p.uji.state === 'open');
});

test('chapter done after uji', () => {
  let p = unlock.initialPhases();
  for (const ph of unlock.PHASES) p = unlock.complete(p, ph);
  assert.ok(unlock.isChapterDone(p));
  assert.deepEqual(unlock.ringValues(p), [1, 1, 1, 1]);
});

test('kuis points and combo', () => {
  assert.equal(scoring.kuisPoints(1, 12), 160);
  assert.equal(scoring.kuisPoints(3, 0), 300);
  let combo = 1;
  for (let i = 0; i < 4; i++) combo = scoring.nextCombo(combo, true);
  assert.equal(combo, 3); // capped
  assert.equal(scoring.nextCombo(3, false), 1);
  assert.equal(scoring.kuisXp(1600), 80);
  assert.ok(scoring.perkuatItemXp(true) === 10 && scoring.perkuatItemXp(false) === 5);
});

test('diagnostic typo suggests fix', () => {
  const d = diagnostics.diagnose('console.log("Total jajan:", jajn);', { name: 'ReferenceError', message: 'jajn is not defined', line: 1 }, 'let jajan = 12000 + 8000;');
  assert.ok(d.available && d.fix.label.includes('jajan') && d.fix.code.includes('jajan);'));
});

test('diagnostic const reassign', () => {
  const d = diagnostics.diagnose('const nyawa = 3;\nnyawa = nyawa - 1;', { name: 'TypeError', message: 'Assignment to constant variable.', line: 2 });
  assert.ok(d.available && d.fix.code.startsWith('let nyawa'));
});

test('diagnostic capped and unknown', () => {
  assert.ok(!diagnostics.diagnose('x', { name: 'ReferenceError', message: 'x is not defined' }, '', 1).available);
  assert.ok(!diagnostics.diagnose('x', { name: 'RangeError', message: 'weird' }).available);
});
