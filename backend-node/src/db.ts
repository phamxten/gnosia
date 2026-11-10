/* Database access. PostgreSQL when GNOSIA_DATABASE_URL is a postgres URL, otherwise PGlite
   (Postgres compiled to WebAssembly, stored in backend-node/data) so development needs no server.

   Every request gets one connection inside a transaction: `db.commit()` makes the work so far permanent and starts a new transaction, and
   whatever is not committed when the request ends (or fails) is rolled back. */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { and, asc, desc, eq, getTableName, inArray, is, ne, sql, type SQL } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzleLite } from 'drizzle-orm/pglite';
import { PgTable, type PgColumn, type PgDatabase, type PgTableWithColumns } from 'drizzle-orm/pg-core';
import pg from 'pg';

import { settings } from './config.ts';
import * as schema from './schema.ts';

export { and, asc, desc, eq, ne, sql };
export const T = schema;

type Q = PgDatabase<any, typeof schema>;
type Conn = { q: Q; exec(sql: string): Promise<unknown>; release(broken?: boolean): void };

let pool: pg.Pool | null = null;
let lite: PGlite | null = null;
let liteQueue: Promise<void> = Promise.resolve();

function start(): void {
  if (pool || lite) return;
  const url = settings.database_url;
  if (url.startsWith('postgresql://')) {
    pool = new pg.Pool({ connectionString: url, max: 10 });
  } else {
    const dir = url.startsWith('pglite://') ? url.slice('pglite://'.length) : undefined; // memory:// = in-memory
    if (dir) mkdirSync(dir, { recursive: true });
    lite = new PGlite(dir);
  }
}

async function connect(): Promise<Conn> {
  start();
  if (pool) {
    const client = await pool.connect();
    return { q: drizzlePg(client, { schema }) as unknown as Q, exec: s => client.query(s), release: b => client.release(b) };
  }
  // PGlite has a single connection: requests take turns (fine for development and tests).
  let done!: () => void;
  const mine = new Promise<void>(r => (done = r));
  const prev = liteQueue;
  liteQueue = prev.then(() => mine);
  await prev;
  return { q: drizzleLite(lite!, { schema }) as unknown as Q, exec: s => lite!.exec(s), release: () => done() };
}

export class Db {
  /** rows fetched by id (identity map): db.get() of a row already seen costs no query */
  readonly seen = new Map<Tbl, Map<number, any>>();
  constructor(private conn: Conn) {}
  get q(): Q { return this.conn.q; }
  /** raw SQL, several statements allowed (DDL) */
  exec(sqlText: string): Promise<unknown> { return this.conn.exec(sqlText); }
  async commit(): Promise<void> {
    await this.conn.exec('COMMIT');
    await this.conn.exec('BEGIN');
  }
}

/** Runs `fn` in a transaction that is rolled back unless `fn` committed. */
export async function withDb<R>(fn: (db: Db) => Promise<R>): Promise<R> {
  const conn = await connect();
  let broken = false;
  try {
    await conn.exec('BEGIN');
    return await fn(new Db(conn));
  } finally {
    try { await conn.exec('ROLLBACK'); } catch { broken = true; }
    conn.release(broken);
  }
}

const SCHEMA_SQL = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
const TABLES = Object.values(schema).filter(t => is(t, PgTable)) as unknown as PgTableWithColumns<any>[];

/** Creates the tables when the database is empty. */
export async function initDb(): Promise<void> {
  await withDb(async db => {
    const rows = await db.q.execute(sql`select to_regclass('public.users') as t`);
    const found = (rows as any).rows?.[0]?.t ?? (rows as any)[0]?.t;
    if (!found) {
      await db.exec(readFileSync(SCHEMA_SQL, 'utf8'));
      await db.commit();
    }
  });
}

/** Drops every table (CASCADE handles the users <-> classes foreign-key cycle). */
export async function dropAll(): Promise<void> {
  await withDb(async db => {
    for (const t of TABLES) await db.exec(`DROP TABLE IF EXISTS "${getTableName(t)}" CASCADE`);
    await db.commit();
  });
}

export async function closeDb(): Promise<void> {
  await liteQueue;
  await pool?.end();
  await lite?.close();
  pool = lite = null;
}

// ------------------------------------------------------------------ helpers
type Tbl = PgTableWithColumns<any>;
type Row<TT extends Tbl> = TT['$inferSelect'];
type Order = SQL | PgColumn;

/** db.get(Model, id) */
export async function get<TT extends Tbl>(db: Db, t: TT, id: number | null | undefined): Promise<Row<TT> | undefined> {
  if (id === null || id === undefined) return undefined;
  let byId = db.seen.get(t);
  if (!byId) db.seen.set(t, (byId = new Map()));
  if (byId.has(id)) return byId.get(id);
  const [r] = await db.q.select().from(t as any).where(eq(t.id, id)).limit(1);
  if (r) byId.set(id, r);
  return r as Row<TT> | undefined;
}

/** db.scalars(select(Model).where(...).order_by(...)); rows come in id order unless told otherwise */
export async function all<TT extends Tbl>(db: Db, t: TT, where?: SQL, ...order: Order[]): Promise<Row<TT>[]> {
  const q = db.q.select().from(t as any).where(where).orderBy(...(order.length ? order : [asc(t.id)]));
  return (await q) as Row<TT>[];
}

/** db.scalar(select(Model).where(...).order_by(...)) */
export async function first<TT extends Tbl>(db: Db, t: TT, where?: SQL, ...order: Order[]): Promise<Row<TT> | undefined> {
  const q = db.q.select().from(t as any).where(where).orderBy(...(order.length ? order : [asc(t.id)])).limit(1);
  return ((await q) as Row<TT>[])[0];
}

export async function count<TT extends Tbl>(db: Db, t: TT, where?: SQL): Promise<number> {
  const [r] = await db.q.select({ n: sql<number>`count(*)::int` }).from(t as any).where(where);
  return Number((r as any)?.n ?? 0);
}

/** db.add(Model(...)) + flush: returns the stored row with its id and defaults */
export async function insert<TT extends Tbl>(db: Db, t: TT, values: Partial<Row<TT>>): Promise<Row<TT>> {
  const [r] = await db.q.insert(t as any).values(values as any).returning();
  return r as Row<TT>;
}

/** obj.field = value for each field, written through right away */
export async function save<TT extends Tbl>(db: Db, t: TT, row: Row<TT>, patch: Partial<Row<TT>>): Promise<Row<TT>> {
  Object.assign(row, patch);
  const cached = db.seen.get(t)?.get(row.id);
  if (cached && cached !== row) Object.assign(cached, patch);
  await db.q.update(t as any).set(patch as any).where(eq(t.id, row.id));
  return row;
}

export async function remove<TT extends Tbl>(db: Db, t: TT, id: number): Promise<void> {
  db.seen.get(t)?.delete(id);
  await db.q.delete(t as any).where(eq(t.id, id));
}

/** col IN (...) that is simply false for an empty list */
export function isIn(col: PgColumn, values: readonly (number | string)[]): SQL {
  return values.length ? inArray(col, [...values]) : sql`false`;
}

export const where = (...parts: (SQL | undefined)[]) => and(...parts);
