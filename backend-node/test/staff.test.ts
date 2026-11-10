/* Mentor signals from the seeded class, review decisions, admin flags and publishing. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { Client, stop } from './helpers.ts';

after(stop);

test('mentor signals', async () => {
  const c = new Client();
  await c.login('dimas@smksig.sch.id');
  const ov = (await c.get('/api/mentor/overview')).json();
  const kinds = new Set(ov.attention.map((a: any) => `${a.learner.name.split(' ')[0]}:${a.kind}`));
  for (const k of ['Alex:repeated', 'Rizky:gate', 'Maya:hints', 'Bayu:stalled']) assert.ok(kinds.has(k), k);
  const alex = ov.attention.find((a: any) => a.kind === 'repeated' && a.learner.name.startsWith('Alex'));
  assert.ok(alex.html.includes('4×') && alex.pattern === 'jawaban yang sama setiap kali');
  assert.equal(ov.attention[0].kind, 'repeated'); // most in need first
  assert.ok(ov.kpis.review >= 2 && ov.kpis.total >= 32);
  assert.equal(ov.funnel.pile.phase, 'perkuat');
  assert.ok(['salinan', 'const'].includes(ov.hardest[0].key));
});

test('learner cannot open mentor', async () => {
  const c = new Client();
  await c.login('nadia@smksig.sch.id');
  assert.equal((await c.get('/api/mentor/overview')).status, 403);
  assert.equal((await c.get('/api/admin/overview')).status, 403);
});

test('review and approve', async () => {
  const c = new Client();
  await c.login('dimas@smksig.sch.id');
  const q = (await c.get('/api/mentor/review')).json().items;
  const sub = q.find((i: any) => i.status === 'pending' && i.title.includes('milestone'));
  const cm = (await c.post(`/api/mentor/submissions/${sub.id}/comments`, { line: 3, body: 'Nama jelas!' })).json();
  assert.equal(cm.line, 3);
  const d = (await c.post(`/api/mentor/submissions/${sub.id}/decision`, { decision: 'approve', summary: 'Lanjut ke milestone 2.' })).json();
  assert.equal(d.status, 'approved');
  await c.login('salsa@smksig.sch.id');
  const p = (await c.get('/api/projects/1')).json();
  assert.ok(p.milestone === 1 && p.status === 'work' && p.thread.some((m: any) => m.body === 'Lanjut ke milestone 2.'));
});

test('admin overview and publish', async () => {
  const c = new Client();
  await c.login('sekar@smksig.sch.id');
  const ov = (await c.get('/api/admin/overview')).json();
  assert.ok(ov.flags.map((f: any) => f.title).join(' ').includes('temukan bug const')); // 58%-ish wrong on first try
  assert.ok(ov.kpis.published === 2 && ov.kpis.chapters === 8);
  const ch = (await c.get('/api/admin/chapters/2')).json();
  assert.ok(ch.version === 3 && !ch.problems.length);
  const draft = ch.draft;
  draft.perkuat.items[0].title = 'Skor akan bertambah. Baris mana yang tepat?';
  assert.equal((await c.put('/api/admin/chapters/2/draft', { draft })).json().next_version, 4);
  assert.equal((await c.post('/api/admin/chapters/2/publish')).json().version, 4);
  const empty = await c.post('/api/admin/chapters/4/publish');
  assert.ok(empty.status === 422 && empty.json().detail.problems.length);
});
