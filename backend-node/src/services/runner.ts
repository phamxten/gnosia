/* Runs learner JavaScript in a Node subprocess (runner/sandbox.mjs).

The program runs in a fresh node:vm context without host objects, with a time limit, and Node's
permission model blocks file writes, child processes and network access. This is adequate for a
school deployment; for a public service put the runner in a container or use isolated-vm. */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

import { BACKEND_DIR, settings } from '../config.ts';
import { get, type Json } from '../util.ts';

export const SANDBOX = join(BACKEND_DIR, 'runner', 'sandbox.mjs');
export const MAX_CODE_CHARS = 20_000;

export class RunnerUnavailable extends Error {}

const charCount = (s: string) => (s.length <= MAX_CODE_CHARS ? s.length : Array.from(s).length);

function failAll(tests: Json[], name: string, message: string, detail: string): Json {
  return { logs: [], error: { name, message, line: null }, vars: {}, results: tests.map(t => ({ id: t.id, pass: false, detail, ms: 0 })) };
}

export async function run(code: string, tests: Json[] = [], varNames: string[] = []): Promise<Json> {
  tests = tests || [];
  if (charCount(code) > MAX_CODE_CHARS) return failAll(tests, 'Error', 'Kode terlalu panjang.', 'kode terlalu panjang');
  const job = { code, tests, vars: varNames || [], timeoutMs: settings.runner_timeout_ms };
  const args = ['--permission', `--allow-fs-read=${dirname(SANDBOX)}`, '--max-old-space-size=64', '--disallow-code-generation-from-strings', SANDBOX];
  const { status, stdout, stderr, timedOut } = await new Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolve, reject) => {
    const proc = spawn(settings.node_bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill('SIGKILL'); }, settings.runner_timeout_ms + 4000);
    proc.stdout.setEncoding('utf8').on('data', d => (out += d));
    proc.stderr.setEncoding('utf8').on('data', d => (err += d));
    proc.on('error', e => { clearTimeout(timer); reject(e); });
    proc.on('close', code => { clearTimeout(timer); resolve({ status: code, stdout: out, stderr: err, timedOut }); });
    proc.stdin.on('error', () => {}); // the child may exit before reading everything
    proc.stdin.end(JSON.stringify(job), 'utf8');
  }).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') throw new RunnerUnavailable('Node.js tidak ditemukan di server.');
    throw e;
  });
  if (timedOut) return failAll(tests, 'TimeoutError', 'Program berjalan terlalu lama (mungkin loop tanpa akhir).', 'program berhenti karena error');
  if (status !== 0 || !stdout.trim()) throw new RunnerUnavailable(`Runner gagal: ${stderr.trim().slice(0, 300)}`);
  return JSON.parse(stdout);
}

export function errorText(err: Json): string {
  if (!err) return '';
  const line = get(err, 'line') ? ` · baris ${err.line}` : '';
  return `${err.name}: ${err.message}${line}`;
}
