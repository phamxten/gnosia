import { buildApp } from './app.ts';

const app = await buildApp({ logger: true });
const port = Number(process.env.PORT ?? process.env.GNOSIA_PORT ?? 8000);
const host = process.env.GNOSIA_HOST ?? '127.0.0.1';

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => app.close().finally(() => process.exit(0)));
await app.listen({ port, host });
