/* Small serializers shared by several routers. */
import { count, Db, eq, get, T, where } from './db.ts';
import { words } from './util.ts';
import type { User } from './schema.ts';
import * as activity from './services/activity.ts';

export function initials(name: string): string {
  const parts = words(name);
  if (!parts.length) return '?';
  if (parts.length === 1) return Array.from(parts[0]).slice(0, 2).join('').toUpperCase();
  return (Array.from(parts[0])[0] + Array.from(parts[1])[0]).toUpperCase();
}

export function person(u: User | null | undefined) {
  if (!u) return null;
  return { id: u.id, name: u.name, initials: initials(u.name), avatar: u.avatar, role: u.role };
}

export async function meView(db: Db, user: User) {
  const klass = user.class_id ? await get(db, T.classes, user.class_id) : undefined;
  const org = user.org_id ? await get(db, T.organizations, user.org_id) : undefined;
  const unread = await count(db, T.notifications, where(eq(T.notifications.user_id, user.id), eq(T.notifications.read, false)));
  return {
    ...person(user)!,
    email: user.email,
    title: user.title,
    onboarded: user.onboarded || user.role !== 'learner',
    goal: user.goal,
    daily_goal_min: user.daily_goal_min,
    assist_cap: user.assist_cap,
    prefs: user.prefs || {},
    class: klass ? { id: klass.id, name: klass.name } : null,
    org: org ? org.name : null,
    streak: await activity.streak(db, user),
    xp_week: await activity.weekXp(db, user.id),
    xp_total: await activity.totalXp(db, user.id),
    today_minutes: await activity.minutesOn(db, user.id, activity.localToday()),
    unread,
    joined: user.created_at ? user.created_at.toISOString() : null,
  };
}

/** Indonesian relative time: "12 menit lalu", "kemarin", "5 hari lalu". */
export function ago(dt: Date | null | undefined): string {
  if (!dt) return 'belum pernah';
  const secs = (Date.now() - dt.getTime()) / 1000;
  if (secs < 60) return 'baru saja';
  if (secs < 3600) return `${Math.floor(secs / 60)} menit lalu`;
  const days = activity.daysBetween(activity.localToday(), activity.localDay(dt));
  if (days === 0) return `${Math.floor(secs / 3600)} jam lalu`;
  if (days === 1) return 'kemarin';
  return `${days} hari lalu`;
}

export function iso(dt: Date | null | undefined): string | null {
  return dt ? dt.toISOString() : null;
}
