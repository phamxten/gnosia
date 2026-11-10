import type { FastifyInstance } from 'fastify';

import type { Chapter } from '../schema.ts';
import { asc, type Db, first, insert, remove, save, sql, T } from '../db.ts';
import { fail, dict, model, oneOf, optional, str } from '../http.ts';
import { clearSession, currentUser, hashPassword, issueSession, verifyPassword } from '../security.ts';
import * as activity from '../services/activity.ts';
import * as learning from '../services/learning.ts';
import { meView } from '../views.ts';
import { h } from './common.ts';

export const DEFAULT_PREFS = { nosi: true, reminders: true, mentor_sees_wrong: true, language: 'id' };

const RegisterIn = model({ name: str({ minLength: 1, maxLength: 120 }), email: str({ minLength: 3, maxLength: 200 }), password: str({ default: '' }) });
const LoginIn = model({ email: str(), password: str({ default: '' }) });
const MeUpdate = model({ name: optional(str({ maxLength: 120 })), daily_goal_min: optional(oneOf([5, 10, 20, 30])), prefs: optional(dict()) });
const DeleteIn = model({ confirm: str() });
// placement: a = "x bernilai 8" (knows basics) · b = wrong · c = never seen code
const OnboardingIn = model({
  goal: oneOf(['sekolah', 'karier', 'bikin', 'penasaran']), placement: oneOf(['a', 'b', 'c']), daily_goal_min: oneOf([5, 10, 20, 30]),
});
const PreviewQuery = model({ placement: oneOf(['a', 'b', 'c']) });

const byEmail = (email: string) => sql`lower(${T.users.email}) = ${email}`;

async function learnChapters(db: Db) {
  const path = await first(db, T.paths, undefined, asc(T.paths.id));
  return path ? (await learning.pathChapters(db, path.id)).filter(c => c.kind === 'chapter') : [];
}

export default function auth(app: FastifyInstance) {
  app.post('/api/auth/register', { schema: { body: RegisterIn } }, h(async (req, reply, db) => {
    const body = req.body as { name: string; email: string; password: string };
    const email = body.email.trim().toLowerCase();
    const errors: Record<string, string> = {};
    if (!email.includes('@')) errors.email = 'Email belum valid.';
    if (!body.password) errors.password = 'Kata sandi tidak boleh kosong.';
    if (!body.name.trim()) errors.name = 'Nama panggilan tidak boleh kosong.';
    if (!Object.keys(errors).length && (await first(db, T.users, byEmail(email)))) errors.email = 'Email ini sudah terdaftar. Coba masuk.';
    if (Object.keys(errors).length) fail(422, { fields: errors });
    const klass = await first(db, T.classes, undefined, asc(T.classes.id)); // demo: new learners join the first class
    const user = await insert(db, T.users, {
      email, name: body.name.trim(), password_hash: await hashPassword(body.password), role: 'learner',
      org_id: klass ? klass.org_id : null, class_id: klass ? klass.id : null, prefs: { ...DEFAULT_PREFS },
    });
    await db.commit();
    issueSession(reply, user);
    return meView(db, user);
  }));

  app.post('/api/auth/login', { schema: { body: LoginIn } }, h(async (req, reply, db) => {
    const body = req.body as { email: string; password: string };
    if (!body.password) fail(422, { fields: { password: 'Kata sandi tidak boleh kosong.' } });
    const user = await first(db, T.users, byEmail(body.email.trim().toLowerCase()));
    if (!user || !(await verifyPassword(body.password, user.password_hash))) fail(401, { fields: { password: 'Email atau kata sandi belum cocok.' } });
    issueSession(reply, user);
    return meView(db, user);
  }));

  app.post('/api/auth/logout', h(async (_req, reply) => {
    clearSession(reply);
    return { ok: true };
  }));

  app.get('/api/me', h(async (req, _reply, db) => meView(db, await currentUser(req, db))));

  app.patch('/api/me', { schema: { body: MeUpdate } }, h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { name: string | null; daily_goal_min: number | null; prefs: Record<string, unknown> | null };
    const patch: Record<string, unknown> = {};
    if (body.name !== null && body.name.trim()) patch.name = body.name.trim();
    if (body.daily_goal_min !== null) patch.daily_goal_min = body.daily_goal_min;
    if (body.prefs !== null) {
      const allowed = Object.fromEntries(Object.entries(body.prefs).filter(([k]) => k in DEFAULT_PREFS));
      patch.prefs = { ...DEFAULT_PREFS, ...(user.prefs || {}), ...allowed };
    }
    if (Object.keys(patch).length) await save(db, T.users, user, patch);
    await db.commit();
    return meView(db, user);
  }));

  app.delete('/api/me', { schema: { body: DeleteIn } }, h(async (req, reply, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { confirm: string };
    if (body.confirm.trim().toLowerCase() !== user.email.toLowerCase()) fail(422, { fields: { confirm: 'Ketik email akunmu untuk konfirmasi.' } });
    if (user.role !== 'learner') fail(403, 'Akun staf dihapus lewat admin.');
    await remove(db, T.users, user.id);
    await db.commit();
    clearSession(reply);
    return { ok: true };
  }));

  app.post('/api/onboarding', { schema: { body: OnboardingIn } }, h(async (req, _reply, db) => {
    const user = await currentUser(req, db);
    const body = req.body as { goal: string; placement: string; daily_goal_min: number };
    const chapters = await learnChapters(db);
    await save(db, T.users, user, { goal: body.goal, daily_goal_min: body.daily_goal_min });
    let start = chapters[0] ?? null;
    let skipped: Chapter | null = null;
    if (body.placement === 'a' && chapters.length > 1 && chapters[1].version) {
      skipped = chapters[0];
      await learning.markChapterSkipped(db, user, skipped);
      start = chapters[1];
    }
    if (start && start.version) await learning.ensureProgress(db, user, start);
    await save(db, T.users, user, { onboarded: true });
    await activity.recordActivity(db, user, 0);
    await db.commit();
    return {
      start: start ? learning.chapterRef(start) : null,
      skipped: skipped ? learning.chapterRef(skipped) : null,
      me: await meView(db, user),
    };
  }));

  /** Tells the last onboarding step where the learner will start. */
  app.get('/api/onboarding/preview', { schema: { querystring: PreviewQuery } }, h(async (req, _reply, db) => {
    const { placement } = req.query as { placement: string };
    await currentUser(req, db);
    const chapters = await learnChapters(db);
    if (placement === 'a' && chapters.length > 1 && chapters[1].version)
      return { start: learning.chapterRef(chapters[1]), skipped: learning.chapterRef(chapters[0]) };
    return { start: chapters.length ? learning.chapterRef(chapters[0]) : null, skipped: null };
  }));
}
