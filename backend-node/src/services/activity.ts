/* XP, daily activity minutes and streaks (CONCEPT §5).
   Days are 'YYYY-MM-DD' strings in the local zone (WIB by default). */
import { settings } from '../config.ts';
import { Db, first, eq, insert, save, sql, T, where } from '../db.ts';
import { pyInt } from '../py.ts';
import type { User } from '../schema.ts';

export const HEARTBEAT_MAX_SECONDS = 60;
const OFFSET_MS = settings.utc_offset_hours * 3_600_000;
const DAY_MS = 86_400_000;

const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

export function localDay(dt: Date): string {
  return new Date(dt.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

export function localToday(): string {
  return localDay(new Date());
}

export function addDays(d: string, n: number): string {
  return new Date(dayMs(d) + n * DAY_MS).toISOString().slice(0, 10);
}

/** date.weekday(): Monday = 0 */
export function weekday(d: string): number {
  return (new Date(dayMs(d)).getUTCDay() + 6) % 7;
}

/** (a - b).days */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayMs(a) - dayMs(b)) / DAY_MS);
}

/** datetime.combine(day, time.min, LOCAL_TZ) */
export function dayStart(d: string): Date {
  return new Date(dayMs(d) - OFFSET_MS);
}

/** dt.astimezone(LOCAL_TZ).strftime("%H.%M") */
export function localHM(dt: Date): string {
  return new Date(dt.getTime() + OFFSET_MS).toISOString().slice(11, 16).replace(':', '.');
}

export async function addXp(db: Db, user: User, amount: number, reason: string): Promise<number> {
  if (amount > 0) await insert(db, T.xp_events, { user_id: user.id, amount, reason });
  return amount;
}

export async function totalXp(db: Db, userId: number): Promise<number> {
  const [r] = await db.q.select({ n: sql<number>`coalesce(sum(${T.xp_events.amount}), 0)::int` }).from(T.xp_events)
    .where(eq(T.xp_events.user_id, userId));
  return Number(r?.n ?? 0);
}

export async function weekXp(db: Db, userId: number): Promise<number> {
  const today = localToday();
  const start = dayStart(addDays(today, -weekday(today)));
  const [r] = await db.q.select({ n: sql<number>`coalesce(sum(${T.xp_events.amount}), 0)::int` }).from(T.xp_events)
    .where(where(eq(T.xp_events.user_id, userId), sql`${T.xp_events.created_at} >= ${start}`));
  return Number(r?.n ?? 0);
}

export async function recordActivity(db: Db, user: User, seconds: number): Promise<void> {
  seconds = Math.max(0, Math.min(HEARTBEAT_MAX_SECONDS, pyInt(seconds)));
  await save(db, T.users, user, { last_active_at: new Date() });
  if (!seconds) return;
  const day = localToday();
  const row = await first(db, T.daily_activity, where(eq(T.daily_activity.user_id, user.id), eq(T.daily_activity.day, day)));
  if (!row) await insert(db, T.daily_activity, { user_id: user.id, day, seconds });
  else await save(db, T.daily_activity, row, { seconds: row.seconds + seconds });
}

export async function minutesOn(db: Db, userId: number, day: string): Promise<number> {
  const row = await first(db, T.daily_activity, where(eq(T.daily_activity.user_id, userId), eq(T.daily_activity.day, day)));
  return Math.floor((row?.seconds ?? 0) / 60);
}

/** Days on which the learner reached their daily goal. */
export async function goalDays(db: Db, user: User, since: string): Promise<Set<string>> {
  const need = Math.max(1, user.daily_goal_min) * 60;
  const rows = await db.q.select({ day: T.daily_activity.day }).from(T.daily_activity).where(where(
    eq(T.daily_activity.user_id, user.id), sql`${T.daily_activity.day} >= ${since}`, sql`${T.daily_activity.seconds} >= ${need}`));
  return new Set(rows.map(r => r.day));
}

/** Consecutive goal days ending today (or yesterday, if today is not reached yet). */
export async function streak(db: Db, user: User): Promise<number> {
  const today = localToday();
  const days = await goalDays(db, user, addDays(today, -400));
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}

/** Mon..Sun of the current week: {label, on, today}. */
export async function weekDots(db: Db, user: User): Promise<{ label: string; on: boolean; today: boolean }[]> {
  const today = localToday();
  const monday = addDays(today, -weekday(today));
  const days = await goalDays(db, user, monday);
  const labels = ['Sn', 'Sl', 'Rb', 'Km', 'Jm', 'Sb', 'Mg'];
  return labels.map((label, i) => ({ label, on: days.has(addDays(monday, i)), today: addDays(monday, i) === today }));
}
