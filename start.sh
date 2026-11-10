#!/usr/bin/env bash
# Nyalakan GNOSIA lokal: backend Node.js http://localhost:8000, frontend http://localhost:5173
cd "$(dirname "$0")"
[ -d backend-node/node_modules ] || (cd backend-node && npm ci --no-audit --no-fund)
[ -d frontend/node_modules ] || (cd frontend && npm ci --no-audit --no-fund)
(cd backend-node && npm run seed) # no-op when the database already has data
trap 'kill 0' EXIT INT TERM
(cd backend-node && exec npm run dev) &
(cd frontend && exec npx vite --port 5173) &
wait
