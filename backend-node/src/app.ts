/* GNOSIA API. In production it also serves the built frontend (frontend/dist) with an SPA fallback. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import cookie from '@fastify/cookie';
import fstatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { settings } from './config.ts';
import { initDb } from './db.ts';
import { HttpError } from './http.ts';
import admin from './routers/admin.ts';
import auth from './routers/auth.ts';
import learner from './routers/learner.ts';
import mentor from './routers/mentor.ts';
import player from './routers/player.ts';
import workspace from './routers/workspace.ts';
import { RunnerUnavailable } from './services/runner.ts';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  await initDb();
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 16 * 1024 * 1024 });

  // An empty body with a JSON content type is `{}`, not an error (FastAPI reads it the same way).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try { done(null, body === '' ? {} : JSON.parse(body as string)); } catch { done(Object.assign(new Error('JSON decode error'), { statusCode: 422 }), undefined); }
  });

  await app.register(cookie);
  await app.register(websocket);

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ detail: err.detail });
    if (err instanceof RunnerUnavailable) return reply.code(503).send({ detail: { code: 'runner', message: err.message } });
    if (err.validation) {
      const detail = err.validation.map((v: any) => ({
        type: v.keyword, loc: [err.validationContext ?? 'body', ...String(v.instancePath).split('/').filter(Boolean), ...(v.params?.missingProperty ? [v.params.missingProperty] : [])],
        msg: v.message,
      }));
      return reply.code(422).send({ detail });
    }
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ detail: err.message });
    req.log.error(err);
    return reply.code(500).send({ detail: 'Internal Server Error' });
  });

  app.get('/api/health', async () => ({ status: 'ok' }));
  for (const route of [auth, learner, player, workspace, mentor, admin]) route(app);

  const dist = settings.frontend_dist;
  const spa = existsSync(dist);
  if (spa) await app.register(fstatic, { root: dist, wildcard: true });
  app.setNotFoundHandler((req, reply) => {
    if (!spa || req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/ws/')) return reply.code(404).send({ detail: 'Not Found' });
    return reply.type('text/html').sendFile('index.html');
  });
  return app;
}

export const indexHtml = (dist: string) => join(dist, 'index.html');
