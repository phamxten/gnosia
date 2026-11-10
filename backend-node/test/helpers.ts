/* A throwaway in-memory database per test file, seeded with the demo curriculum and class. */
process.env.GNOSIA_DATABASE_URL = process.env.GNOSIA_TEST_DATABASE_URL || 'memory://'; // set GNOSIA_TEST_DATABASE_URL to run the suite against PostgreSQL (the database is reset!)
process.env.GNOSIA_FRONTEND_DIST = '/nonexistent';
delete process.env.GNOSIA_DEMO_PASSWORD;

const { buildApp } = await import('../src/app.ts');
const { run } = await import('../src/seed/seed.ts');
const { closeDb } = await import('../src/db.ts');

await run(true);
const app = await buildApp();
export const PASSWORD = 'gnosia123';

/** A tiny HTTP client with a cookie jar, like fastapi.testclient.TestClient. */
export class Client {
  cookies = new Map<string, string>();
  async request(method: string, url: string, body?: unknown) {
    const res = await app.inject({
      method: method as 'GET', url, payload: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] ?? [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || kv.slice(i + 1) === '') this.cookies.delete(kv.slice(0, i));
      else this.cookies.set(kv.slice(0, i), kv.slice(i + 1));
    }
    return { status: res.statusCode, text: res.body, json: <T = any>() => JSON.parse(res.body) as T };
  }
  get = (url: string) => this.request('GET', url);
  post = (url: string, body: unknown = {}) => this.request('POST', url, body);
  put = (url: string, body: unknown = {}) => this.request('PUT', url, body);
  patch = (url: string, body: unknown = {}) => this.request('PATCH', url, body);
  async login(email: string) {
    const r = await this.post('/api/auth/login', { email, password: PASSWORD });
    if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${r.text}`);
  }
}

export async function stop() {
  await app.close();
  await closeDb();
}
