/* Database access via MySQL / MariaDB (mysql2 + Drizzle ORM).

   Every request gets one pooled connection inside a transaction: `db.commit()` makes the work so far
   permanent and starts a new transaction, and whatever is not committed when the request ends (or fails)
   is rolled back. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, asc, desc, eq, getTableName, gt, gte, inArray, is, isNotNull, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm';
import { MySqlTable, type MySqlColumn, type MySqlTableWithColumns } from 'drizzle-orm/mysql-core';
import { drizzle as drizzleMysql, type MySql2Database } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';

import { settings } from './config.ts';
import * as schema from './schema.ts';

export { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, sql };
export const T = schema;

type Q = MySql2Database<typeof schema>;

let pool: mysql.Pool | null = null;

function getPool(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      ...settings.db,
      waitForConnections: true,
      connectionLimit: settings.db_pool_size,
      charset: 'utf8mb4',
      timezone: 'Z',
      dateStrings: true,
      jsonStrings: true, // keep JSON as raw UTF-8 text on both MySQL 8 and MariaDB so schema.ts parses once
    } as mysql.PoolOptions);
  }
  return pool;
}

export class Db {
  /** rows fetched by id (identity map): db.get() of a row already seen costs no query */
  readonly seen = new Map<Tbl, Map<number, any>>();
  readonly q: Q;
  constructor(private conn: mysql.PoolConnection) {
    this.q = drizzleMysql(conn, { schema, mode: 'default' }) as unknown as Q;
  }
  async commit(): Promise<void> {
    await this.conn.commit();
    await this.conn.beginTransaction();
  }
}

/** Runs `fn` in a transaction that is rolled back unless `fn` committed. */
export async function withDb<R>(fn: (db: Db) => Promise<R>): Promise<R> {
  const conn = await getPool().getConnection();
  let broken = false;
  try {
    await conn.beginTransaction();
    return await fn(new Db(conn));
  } finally {
    try {
      await conn.rollback();
    } catch {
      broken = true;
    }
    if (broken) conn.destroy();
    else conn.release();
  }
}

const SCHEMA_SQL = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
const TABLES = Object.values(schema).filter(t => is(t, MySqlTable)) as unknown as MySqlTableWithColumns<any>[];

function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
}

/** Creates the tables when the database is empty. (DDL causes an implicit commit in MySQL, so run outside withDb.) */
export async function initDb(): Promise<void> {
  const p = getPool();
  const [rows] = await p.query<mysql.RowDataPacket[]>(
    'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1',
    ['users'],
  );
  if (!rows.length) {
    const ddl = readFileSync(SCHEMA_SQL, 'utf8');
    const conn = await p.getConnection();
    try {
      for (const stmt of splitStatements(ddl)) await conn.query(stmt);
    } finally {
      conn.release();
    }
  }
}

/** Drops every table (FOREIGN_KEY_CHECKS = 0 handles the users <-> classes foreign-key cycle). */
export async function dropAll(): Promise<void> {
  const conn = await getPool().getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) await conn.query(`DROP TABLE IF EXISTS \`${getTableName(t)}\``);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = null;
}

// ------------------------------------------------------------------ helpers
type Tbl = MySqlTableWithColumns<any>;
type Row<TT extends Tbl> = TT['$inferSelect'];
type Order = SQL | MySqlColumn;

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
export async function all<TT extends Tbl>(db: Db, t: TT, whereCond?: SQL, ...order: Order[]): Promise<Row<TT>[]> {
  const q = db.q.select().from(t as any).where(whereCond).orderBy(...(order.length ? order : [asc(t.id)]));
  return (await q) as Row<TT>[];
}

/** db.scalar(select(Model).where(...).order_by(...)) */
export async function first<TT extends Tbl>(db: Db, t: TT, whereCond?: SQL, ...order: Order[]): Promise<Row<TT> | undefined> {
  const q = db.q.select().from(t as any).where(whereCond).orderBy(...(order.length ? order : [asc(t.id)])).limit(1);
  return ((await q) as Row<TT>[])[0];
}

export async function count<TT extends Tbl>(db: Db, t: TT, whereCond?: SQL): Promise<number> {
  const [r] = await db.q.select({ n: sql<number>`count(*)` }).from(t as any).where(whereCond);
  return Number((r as any)?.n ?? 0);
}

/** db.add(Model(...)) + flush: inserts the row, reads it back by insertId, and caches it in the identity map */
export async function insert<TT extends Tbl>(db: Db, t: TT, values: Partial<Row<TT>>): Promise<Row<TT>> {
  const [{ id }] = await db.q.insert(t as any).values(values as any).$returningId();
  return (await get(db, t, id))!;
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
export function isIn(col: MySqlColumn, values: readonly (number | string)[]): SQL {
  return values.length ? inArray(col, [...values]) : sql`false`;
}

export const where = (...parts: (SQL | undefined)[]) => and(...parts);
