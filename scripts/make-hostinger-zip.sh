#!/usr/bin/env bash
# Build frontend + backend di lokal, lalu bungkus menjadi gnosia-hostinger.zip yang ringan (~1-2 MB)
# untuk di-upload ke fitur "Node.js Web Apps" di hPanel Hostinger.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="gnosia-hostinger.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

echo "1/3 Build frontend (React + Vite)..."
npm --prefix frontend ci --include=dev --no-audit --no-fund
npm --prefix frontend run build

echo "2/3 Build backend (Fastify + TypeScript + MySQL)..."
npm --prefix backend-node ci --include=dev --no-audit --no-fund
npm --prefix backend-node run build

echo "3/3 Mengemas $OUT..."
mkdir -p "$STAGE/scripts" "$STAGE/frontend" "$STAGE/backend-node"
cp package.json server.js "$STAGE/"
cp scripts/build-hostinger.mjs "$STAGE/scripts/"
cp -r frontend/dist "$STAGE/frontend/dist"
cp backend-node/package.json backend-node/package-lock.json "$STAGE/backend-node/"
cp -r backend-node/dist "$STAGE/backend-node/dist"
cp -r backend-node/runner "$STAGE/backend-node/runner"

rm -f "$OUT"
(
  cd "$STAGE"
  if command -v zip >/dev/null 2>&1; then
    zip -rq "$OLDPWD/$OUT" .
  else
    python3 -m zipfile -c "$OLDPWD/$OUT" .
  fi
)

ls -lh "$OUT"
echo "Selesai! Upload $OUT ke Hostinger hPanel -> Websites -> Add Website -> Node.js Apps."
