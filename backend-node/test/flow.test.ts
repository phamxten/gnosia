/* A new learner goes through Bab 1 end to end: register → onboarding → Pahami → Perkuat
   (adaptive item, hints, L6 gate) → Kuis (fail, then pass) → Challenge → Bab 2 unlocks. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { Client, stop } from './helpers.ts';

after(stop);

const bab1 = JSON.parse(readFileSync(new URL('../src/seed/data/bab1_halo.json', import.meta.url), 'utf8'));
const ITEMS: Record<string, any> = Object.fromEntries(bab1.perkuat.items.map((i: any) => [i.id, i]));
const BANK: Record<string, any> = Object.fromEntries(bab1.kuis.bank.map((q: any) => [q.id, q]));

const rightAnswer = (item: any) => (item.type === 'match' ? item.left.map((p: any) => [p.key, p.key]) : item.answer);
function wrongAnswer(item: any) {
  const t = item.type;
  if (t === 'choice' || t === 'predict') return (item.answer + 1) % item.choices.length;
  if (t === 'bug') return item.answer !== 1 ? 1 : 2;
  if (t === 'fill' || t === 'parsons') return [...item.answer].reverse();
  throw new Error(t);
}

async function register(c: Client) {
  const email = `tes-${randomBytes(3).toString('hex')}@contoh.id`;
  let r = await c.post('/api/auth/register', { name: 'Tes', email, password: '' });
  assert.ok(r.status === 422 && r.json().detail.fields.password === 'Kata sandi tidak boleh kosong.');
  r = await c.post('/api/auth/register', { name: 'Tes', email, password: 'x' });
  assert.ok(r.status === 200 && !r.json().onboarded);
  return email;
}

test('full chapter', async () => {
  const c = new Client();
  await register(c);
  let r = await c.post('/api/onboarding', { goal: 'penasaran', placement: 'c', daily_goal_min: 10 });
  assert.ok(r.status === 200 && r.json().start.number === 1);
  let home = (await c.get('/api/home')).json();
  assert.ok(home.first_time && home.continue.chapter.number === 1);

  // locked phases redirect to the chapter page
  r = await c.get('/api/chapters/1/kuis');
  assert.ok(r.status === 409 && r.json().detail.redirect === '/bab/1');
  r = await c.get('/api/chapters/2');
  assert.ok(r.status === 409 && r.json().detail.code === 'locked');

  // Pahami
  const p = (await c.get('/api/chapters/1/pahami')).json();
  assert.ok(p.scenes.length === 6 && p.scene === 1);
  await c.post('/api/chapters/1/pahami/scene', { scene: 4 });
  assert.equal((await c.get('/api/chapters/1/pahami')).json().scene, 4); // resumable
  let done = (await c.post('/api/chapters/1/pahami/complete')).json();
  assert.ok(done.xp === 50 && done.phases.perkuat.state === 'open');
  assert.equal((await c.post('/api/chapters/1/pahami/complete')).json().xp, 0); // idempotent

  // Perkuat
  const pk = (await c.get('/api/chapters/1/perkuat')).json();
  const ids: string[] = pk.items.map((i: any) => i.id);
  assert.ok(!ids.includes('b5b') && !('answer' in pk.items[0]));
  assert.equal((await c.post('/api/chapters/1/perkuat/complete')).status, 409); // nothing solved yet
  for (const iid of ids) {
    const item = ITEMS[iid];
    if (iid === 'b5') {
      const w = (await c.post('/api/chapters/1/perkuat/check', { item_id: iid, answer: wrongAnswer(item) })).json();
      assert.ok(!w.correct && w.inserted.id === 'b5b' && w.hint);
      const hint = (await c.post('/api/chapters/1/perkuat/hint', { item_id: iid, ms_since_shown: 5000 })).json();
      assert.equal(hint.level, 4);
      await c.post('/api/chapters/1/perkuat/check', { item_id: iid, answer: wrongAnswer(item) });
      assert.equal((await c.post('/api/chapters/1/perkuat/solution', { item_id: iid })).status, 403);
      await c.post('/api/chapters/1/perkuat/check', { item_id: iid, answer: wrongAnswer(item) });
      const sol = await c.post('/api/chapters/1/perkuat/solution', { item_id: iid });
      assert.ok(sol.status === 200 && sol.json().level === 6);
    }
    const ok = (await c.post('/api/chapters/1/perkuat/check', { item_id: iid, answer: rightAnswer(item) })).json();
    assert.ok(ok.correct, iid);
    assert.equal(ok.xp, iid !== 'b5' ? 10 : 5);
  }
  assert.equal((await c.post('/api/chapters/1/perkuat/complete')).status, 409); // the inserted similar item must be solved too
  assert.ok((await c.post('/api/chapters/1/perkuat/check', { item_id: 'b5b', answer: rightAnswer(ITEMS.b5b) })).json().correct);
  done = (await c.post('/api/chapters/1/perkuat/complete')).json();
  assert.ok(done.accuracy === Math.round((100 * 6) / 7) && done.phases.kuis.state === 'open');

  // Kuis: fail first (all wrong), then pass
  let rnd = (await c.post('/api/chapters/1/kuis/rounds', {})).json();
  assert.ok(rnd.questions.length === 10 && !('a' in rnd.questions[0]));
  for (const [i, q] of rnd.questions.entries()) {
    const a = (await c.post(`/api/kuis/rounds/${rnd.round_id}/answer`, { index: i, choice: (BANK[q.id].a + 1) % 4, left: 10 })).json();
    assert.ok(!a.correct && a.combo === 1);
  }
  let res = (await c.post(`/api/kuis/rounds/${rnd.round_id}/finish`)).json();
  assert.ok(!res.passed && res.pct === 0 && res.missing === 70 && res.review.length === 10);
  assert.equal((await c.get('/api/chapters/1/challenge')).status, 409); // Uji still locked

  rnd = (await c.post('/api/chapters/1/kuis/rounds', {})).json();
  const combos: number[] = [];
  for (const [i, q] of rnd.questions.entries())
    combos.push((await c.post(`/api/kuis/rounds/${rnd.round_id}/answer`, { index: i, choice: BANK[q.id].a, left: 15 })).json().combo);
  assert.deepEqual(combos.slice(0, 3), [2, 3, 3]);
  res = (await c.post(`/api/kuis/rounds/${rnd.round_id}/finish`)).json();
  assert.ok(res.passed && res.pct === 100 && res.uji.challenge);

  // Challenge (L1 only): a wrong program, then the right one
  const ch = (await c.get('/api/chapters/1/challenge')).json();
  assert.ok(ch.challenge.tests.every((t: any) => !('kind' in t)));
  const bad = (await c.post('/api/chapters/1/challenge/run', { code: 'console.log("Halo, aku Nosi")\nconsole.log(15)' })).json();
  assert.ok(bad.passed === 3 && !bad.all_pass);
  const good = (await c.post('/api/chapters/1/challenge/run', { code: 'console.log("Halo, aku Nosi");\nconsole.log(2025 - 2010);' })).json();
  assert.ok(good.all_pass && good.chapter_done && good.next_chapter.number === 2);
  assert.equal((await c.get('/api/chapters/2')).status, 200); // Bab 2 unlocked
  home = (await c.get('/api/home')).json();
  assert.ok(home.continue.chapter.number === 2 && !home.first_time);
});

test('placement skips bab1', async () => {
  const c = new Client();
  await register(c);
  const r = (await c.post('/api/onboarding', { goal: 'sekolah', placement: 'a', daily_goal_min: 20 })).json();
  assert.ok(r.start.number === 2 && r.skipped.number === 1);
  const home = (await c.get('/api/home')).json();
  assert.ok(home.first_time && home.continue.chapter.number === 2);
});

test('ulangan resume and submit', async () => {
  const c = new Client();
  await c.login('salsa@smksig.sch.id'); // Bab 2 finished via challenge, Ulangan still available for practice
  const s = (await c.post('/api/chapters/2/ulangan/start')).json().session;
  let again = (await c.post('/api/chapters/2/ulangan/start')).json().session;
  assert.equal(again.id, s.id); // resumable
  await c.put(`/api/ulangan/${s.id}/answers`, { qid: 'u1', answer: 1 });
  await c.put(`/api/ulangan/${s.id}/flags`, { flags: ['u2'] });
  again = (await c.post('/api/chapters/2/ulangan/start')).json().session;
  assert.ok(JSON.stringify(again.answers) === JSON.stringify({ u1: 1 }) && JSON.stringify(again.flags) === JSON.stringify(['u2']));
  const final = { u2: 2, u3: 'let', u4: 1, u5: 'const harga = 50000;\nconst diskon = 10000;\nconsole.log(harga - diskon);', u6: 2, u7: 2, u8: 1 };
  const res = (await c.post(`/api/ulangan/${s.id}/submit`, { answers: final })).json();
  assert.ok(res.result.score === 90 && res.result.passed);
  const wrong = res.result.rows.filter((r: any) => !r.ok);
  assert.ok(wrong.length === 1 && wrong[0].note.includes('seharusnya 2'));
  assert.equal((await c.put(`/api/ulangan/${s.id}/answers`, { qid: 'u1', answer: 0 })).status, 409);
});
