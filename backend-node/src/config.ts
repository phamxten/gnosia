/* App settings. Override any field with an environment variable prefixed GNOSIA_
   (e.g. GNOSIA_DATABASE_URL=mysql://user:pass@127.0.0.1:3306/gnosia, or individual GNOSIA_DB_* variables).
   backend-node/.env is read too. */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolOptions } from 'mysql2/promise';

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

/** Parses either GNOSIA_DATABASE_URL (mysql://...) or individual GNOSIA_DB_* variables
    (convenient on Hostinger hPanel so passwords with special characters need no URL encoding). */
function parseDbConfig(): { url: string; pool: PoolOptions } {
  const rawUrl = env('DATABASE_URL')?.trim();
  if (rawUrl) {
    if (/^postgres(?:ql)?(?:\+\w+)?:\/\//i.test(rawUrl) || rawUrl.startsWith('pglite://') || rawUrl === 'memory://') {
      throw new Error(
        'GNOSIA sekarang memakai MySQL penuh. Ubah GNOSIA_DATABASE_URL ke format mysql://user:password@host:3306/nama_db ' +
          'atau isi variabel GNOSIA_DB_HOST, GNOSIA_DB_USER, GNOSIA_DB_PASSWORD, dan GNOSIA_DB_NAME.',
      );
    }
    const normalized = rawUrl.replace(/^mysql(?:2|\+\w+)?:\/\//i, 'mysql://');
    const u = new URL(normalized);
    if (u.protocol !== 'mysql:') {
      throw new Error(`Skema GNOSIA_DATABASE_URL tidak didukung (${u.protocol}). Gunakan mysql://user:password@host:3306/nama_db`);
    }
    const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
    if (!database) throw new Error('Nama database belum tercantum di GNOSIA_DATABASE_URL (contoh: mysql://user:pass@127.0.0.1:3306/gnosia).');
    const socketPath = u.searchParams.get('socketPath') || env('DB_SOCKET') || undefined;
    const sslParam = u.searchParams.get('ssl');
    const pool: PoolOptions = {
      user: decodeURIComponent(u.username || 'root'),
      password: decodeURIComponent(u.password || ''),
      database,
      ...(socketPath ? { socketPath } : { host: u.hostname || '127.0.0.1', port: u.port ? Number(u.port) : 3306 }),
      ...(sslParam ? { ssl: sslParam === 'true' || sslParam === '1' ? {} : JSON.parse(sslParam) } : {}),
    };
    return { url: normalized, pool };
  }

  const host = env('DB_HOST')?.trim() || '127.0.0.1';
  const port = int(env('DB_PORT'), 3306);
  const user = env('DB_USER')?.trim() || 'gnosia';
  const password = env('DB_PASSWORD') ?? 'gnosia';
  const database = env('DB_NAME')?.trim() || 'gnosia';
  const socketPath = env('DB_SOCKET')?.trim() || undefined;

  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  const url = `mysql://${auth}@${host}:${port}/${encodeURIComponent(database)}`;
  const pool: PoolOptions = {
    user,
    password,
    database,
    ...(socketPath ? { socketPath } : { host, port }),
  };
  return { url, pool };
}

const dbCfg = parseDbConfig();

export const settings = {
  database_url: dbCfg.url,
  db: dbCfg.pool,
  db_pool_size: int(env('DB_POOL_SIZE'), 10),
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
