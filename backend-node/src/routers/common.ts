import type { FastifyReply, FastifyRequest } from 'fastify';

import { type Db, withDb } from '../db.ts';

/** A route handler with its own database transaction. */
export function h(fn: (req: FastifyRequest, reply: FastifyReply, db: Db) => Promise<unknown>) {
  return (req: FastifyRequest, reply: FastifyReply) => withDb(db => fn(req, reply, db));
}
