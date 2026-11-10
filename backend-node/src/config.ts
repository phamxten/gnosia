/* App settings. Override any field with an environment variable prefixed GNOSIA_
   (e.g. GNOSIA_DATABASE_URL=postgresql://...). backend-node/.env is read too. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROOT_DIR = resolve(BACKEND_DIR, '..');

const envFile = join(BACKEND_DIR, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile); // never overrides variables that are already set

const env = (k: string) => process.env[`GNOSIA_${k}`];

function bool(v: string | undefined, def: boolean): boolean {
  if (v === undefined || v === '') return def;
  const s = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 't', 'y'].includes(s)) return true;
  if (['0', 'false', 'no', 'off', 'f', 'n'].includes(s)) return false;
  throw new Error(`GNOSIA_* boolean tidak valid: ${v}`);
}

function int(v: string | undefined, def: number): number {
  if (v === undefined || v === '') return def;
  if (!/^\s*[+-]?\d+\s*$/.test(v)) throw new Error(`GNOSIA_* angka tidak valid: ${v}`);
  return parseInt(v, 10);
}

/** Hosted Postgres hands out postgres:// or postgresql://; the legacy postgresql+psycopg:// form of older .env files is accepted too.
    Anything else (unset, or the old sqlite:/// default) means the embedded PGlite database in backend-node/data. */
function databaseUrl(v: string | undefined): string {
  const m = (v ?? '').match(/^postgres(?:ql)?(?:\+\w+)?:\/\/(.*)$/);
  if (m) return `postgresql://${m[1]}`;
  if (v?.startsWith('memory://') || v?.startsWith('pglite://')) return v;
  return `pglite://${join(BACKEND_DIR, 'data', 'pglite')}`;
}

export const settings = {
  database_url: databaseUrl(env('DATABASE_URL')),
  secret_key: env('SECRET_KEY') || 'dev-only-change-me-in-production',
  session_cookie: env('SESSION_COOKIE') || 'gnosia_session',
  session_days: int(env('SESSION_DAYS'), 30),
  cookie_secure: bool(env('COOKIE_SECURE'), false),
  // Day boundaries for streaks and daily goals (WIB, no DST).
  utc_offset_hours: int(env('UTC_OFFSET_HOURS'), 7),
  node_bin: env('NODE_BIN') || process.execPath,
  runner_timeout_ms: int(env('RUNNER_TIMEOUT_MS'), 1000),
  frontend_dist: env('FRONTEND_DIST') || join(ROOT_DIR, 'frontend', 'dist'),
};
