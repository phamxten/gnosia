import bcrypt from 'bcrypt';
import type { FastifyReply, FastifyRequest } from 'fastify';
import jwt from 'jsonwebtoken';

import { settings } from './config.ts';
import { Db, get, T } from './db.ts';
import { fail } from './http.ts';
import type { User } from './schema.ts';

const ALGO = 'HS256';

// bcrypt only reads the first 72 bytes: cut there explicitly, as the Python backend did, so hashes stay interchangeable.
const bytes = (pw: string) => Buffer.from(pw, 'utf8').subarray(0, 72);

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(bytes(pw), 12);
}

export async function verifyPassword(pw: string, hashed: string): Promise<boolean> {
  try {
    return await bcrypt.compare(bytes(pw), hashed);
  } catch {
    return false;
  }
}

export function issueSession(reply: FastifyReply, user: User): void {
  const exp = Math.floor(Date.now() / 1000) + settings.session_days * 86400;
  const token = jwt.sign({ sub: String(user.id), role: user.role, exp }, settings.secret_key, { algorithm: ALGO });
  reply.setCookie(settings.session_cookie, token, {
    maxAge: settings.session_days * 86400, httpOnly: true, sameSite: 'lax', secure: settings.cookie_secure, path: '/',
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(settings.session_cookie, { path: '/' });
}

export async function userFromToken(db: Db, token: string | undefined): Promise<User | undefined> {
  if (!token) return undefined;
  let data: jwt.JwtPayload;
  try {
    data = jwt.verify(token, settings.secret_key, { algorithms: [ALGO] }) as jwt.JwtPayload;
  } catch {
    return undefined;
  }
  const id = Number(data.sub);
  return Number.isInteger(id) ? get(db, T.users, id) : undefined;
}

export async function currentUser(req: FastifyRequest, db: Db): Promise<User> {
  const user = await userFromToken(db, req.cookies[settings.session_cookie]);
  if (!user) fail(401, 'Silakan masuk dulu.');
  return user;
}

export async function requireRole(req: FastifyRequest, db: Db, ...roles: string[]): Promise<User> {
  const user = await currentUser(req, db);
  if (!roles.includes(user.role)) fail(403, 'Kamu tidak punya akses ke halaman ini.');
  return user;
}
