import { buildApp } from './app.ts';

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? process.env.GNOSIA_PORT ?? 8000);
// Listen on 0.0.0.0 automatically when PORT is injected by Hostinger / reverse proxies or in production.
const host = process.env.GNOSIA_HOST ?? (process.env.PORT || process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => app.close().finally(() => process.exit(0)));
await app.listen({ port, host });
