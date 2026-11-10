# GNOSIA — one image: the Node.js (Fastify) backend serves the API, the WebSocket and the built React app on port 8000.
# Node.js is also what runs learner code (backend-node/runner/sandbox.mjs), so one runtime does everything.
# The previous Python/FastAPI image is kept as Dockerfile.python until the Node backend has run in production.

# ---- 1. build the frontend ---------------------------------------------------------
FROM node:24-bookworm-slim AS web
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. build the backend ----------------------------------------------------------
FROM node:24-bookworm-slim AS api
WORKDIR /src/backend-node
COPY backend-node/package.json backend-node/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY backend-node/ ./
RUN npm run build && npm prune --omit=dev

# ---- 3. runtime -----------------------------------------------------------------------
FROM node:24-bookworm-slim AS app
ENV NODE_ENV=production GNOSIA_HOST=0.0.0.0 PORT=8000
WORKDIR /app/backend-node
COPY --from=api /src/backend-node/package.json ./
COPY --from=api /src/backend-node/node_modules ./node_modules
COPY --from=api /src/backend-node/dist ./dist
COPY --from=api /src/backend-node/runner ./runner
COPY --from=web /src/frontend/dist /app/frontend/dist

# run as an unprivileged user (the embedded database, used only without GNOSIA_DATABASE_URL, lives in ./data)
RUN mkdir -p data && chown -R node:node /app
USER node

EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:8000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Create tables and seed the demo data on first start (skipped when the database already has data), then serve.
CMD ["sh", "-c", "node dist/seed/index.js && exec node dist/main.js"]
