/* Smart build script for Hostinger Node.js Web Apps:
   - If full source is present (GitHub deploy), compiles frontend/dist and backend-node/dist, then prunes dev deps.
   - If pre-built dist folders are already packaged (gnosia-hostinger.zip upload), only installs production backend deps. */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd: root, stdio: 'inherit' });
};

if (existsSync(join(root, 'frontend', 'src'))) {
  run('npm --prefix frontend ci --include=dev --no-audit --no-fund');
  run('npm --prefix frontend run build');
} else if (!existsSync(join(root, 'frontend', 'dist', 'index.html'))) {
  throw new Error('frontend/src maupun frontend/dist tidak ditemukan.');
} else {
  console.log('frontend/dist sudah tersedia, lewati build frontend.');
}

if (existsSync(join(root, 'backend-node', 'src'))) {
  run('npm --prefix backend-node ci --include=dev --no-audit --no-fund');
  run('npm --prefix backend-node run build');
  if (process.env.NODE_ENV === 'production') {
    run('npm --prefix backend-node prune --omit=dev --no-audit --no-fund');
  }
} else if (existsSync(join(root, 'backend-node', 'dist', 'start.js'))) {
  console.log('backend-node/dist sudah tersedia, pasang dependency produksi backend saja.');
  run('npm --prefix backend-node ci --omit=dev --no-audit --no-fund');
} else {
  throw new Error('backend-node/src maupun backend-node/dist tidak ditemukan.');
}
