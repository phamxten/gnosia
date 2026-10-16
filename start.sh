#!/usr/bin/env bash
# Nyalakan GNOSIA lokal: backend http://localhost:8000, frontend http://localhost:5173
cd "$(dirname "$0")"
[ -f backend/gnosia.db ] || (cd backend && ../.venv-linux/bin/python -m app.seed)
trap 'kill 0' EXIT INT TERM
(cd backend && exec ../.venv-linux/bin/uvicorn app.main:app --port 8000) &
(cd frontend && exec npx vite --port 5173) &
wait
