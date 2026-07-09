# AGENTS.md

## Project structure

This repo is a WhatsApp AI chatbot system. It has **two separate Node projects** with no root package.json:

| Directory | Tech | What it does |
|-----------|------|-------------|
| `openwa/` | NestJS 11 + TS 5 + TypeORM | WhatsApp API gateway (v0.1.6). Port **2785** (API), **2886** (dashboard) |
| `backend/` | Express 4 + JS + PostgreSQL | AI lead-capture bot. Ollama LLM, flow-based conversation, CRM sync. Port **3000** |

Root `docker-compose.yml` orchestrates everything (nginx, openwa-api, openwa-dashboard, ollama, backend).

## Commands

### OpenWA (`openwa/`)
- `npm run dev` — starts API + dashboard concurrently
- `npm run start:dev` — API only with hot-reload
- `npm test` — Jest unit tests (`*.spec.ts`)
- `npm run test:e2e` — e2e tests
- `npm run lint` — ESLint with `--fix`
- `npm run format` — Prettier (single quotes, trailing commas, printWidth 120, semi)
- `npm run migration:run` — run TypeORM migrations (dev)
- `npm run migration:run:prod` — run migrations in production

### Backend (`backend/`)
- `npm start` — starts `src/server.js`
- No tests, no linter, no typecheck configured

### Docker (root)
- `docker compose up -d` — full stack in detached mode
- `docker compose --profile full up -d` — OpenWA standalone with all options

## Architecture

**Config loading order** (OpenWA): process env > `.env` > `data/.env.generated`. Later sources do NOT override earlier ones.

**Two TypeORM connections** in OpenWA:
- `main` — always SQLite (auth, audit entities, auto-sync)
- `data` — SQLite (default, auto-sync) or PostgreSQL (migrations only, never auto-sync in prod)

**QueueModule** is lazy-loaded only when `QUEUE_ENABLED=true` (avoids Redis connection errors otherwise).

**Backend uses raw SQL + `pg` pool** (no ORM) with a `customers` table and allowed memory fields in `backend/src/memory.js:21`.

**Webhook dedup** is in-memory with 24h TTL keyed by `deliveryId`.

## Key constraints

- OpenWA env must have `API_MASTER_KEY` set (or backed by `openwa/.env`)
- Backend env requires all vars in `backend/src/server.js:23-35`
- `backend/.env` at root configures DB, Ollama, OpenWA connection, CRM
- Backend **PostgreSQL** schema is in `backend/schema/002_crm_tables.sql`
- OpenWA **Chromium** for `whatsapp-web.js` — bundled in Dockerfile, set via `PUPPETEER_EXECUTABLE_PATH`

## CI (OpenWA only)
- Workflows in `openwa/.github/workflows/`
- Lint → test → dashboard build → project build → docker push (on push to main)
