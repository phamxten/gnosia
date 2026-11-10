import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import * as runner from '../src/services/runner.ts';

const CHALLENGE = JSON.parse(readFileSync(new URL('../src/seed/data/bab2_variabel.json', import.meta.url), 'utf8')).challenge;
const BUG = 'const namaTim = "Garuda";\nconst skor = 0;\n\nskor = skor + 3;\nskor = skor + 3;\n\nconsole.log(namaTim + ": " + skor);\n';

test('const reassign marks line', async () => {
  const r = await runner.run(BUG, CHALLENGE.tests);
  assert.ok(r.error.name === 'TypeError' && r.error.line === 4);
  assert.deepEqual(r.results.map((t: any) => t.pass), [true, false, false, false]);
  assert.equal(r.results[1].detail, 'skor harus bisa diubah');
});

test('solution passes all', async () => {
  const r = await runner.run(BUG.replace('const skor', 'let skor'), CHALLENGE.tests);
  assert.deepEqual(r.logs, ['Garuda: 6']);
  assert.ok(r.results.every((t: any) => t.pass));
});

test('failure detail uses program values', async () => {
  const code = 'const namaTim = "Garuda";\nlet skor = 0;\nskor = skor + 3;\nconsole.log(namaTim + ": " + skor);';
  const r = await runner.run(code, CHALLENGE.tests);
  assert.ok(r.results[2].detail === 'skor akhir 3' && r.results[3].detail === 'output "Garuda: 3"');
});

test('sandbox blocks escape and loops', async () => {
  let r = await runner.run('this.constructor.constructor("return process")()', []);
  assert.notEqual(r.error, null);
  r = await runner.run('while (true) {}', []);
  assert.equal(r.error.name, 'TimeoutError');
});
