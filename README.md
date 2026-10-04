# Wonderworks · Requirements Studio

A standalone requirements platform. Projects contain sections, requirements, dependencies, acceptance criteria, revision history, immutable baselines, and verification evidence. The included Asteroids specification is ordinary project data, not a coupled game implementation.

## Development

Requires Node.js 22.13 or later and npm.

```sh
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_graceful_terror.sql
npm run dev
```

Apply the migration once to a new local database. Development uses `http://127.0.0.1:5173/`; local data persists under `.wrangler/state`. Production uses the declared D1 binding and private Sites access. Do not expose the API publicly without adding authorization.

## Data and integration

- The D1 database is authoritative after first initialization. `data/workspace.json` supplies the initial requirements workspace; editing it does not overwrite an existing database.
- `GET /api/workspace?index=1` lists projects. `GET /api/workspace?project=<id>` reads one.
- `POST /api/workspace` takes `project`, the last read `version`, an `action`, and its payload. Stale writes return HTTP 409.
- Actions: `project`, `section`, `requirements`, `delete`, `baseline`, and `evidence`.
- Baselines preserve full requirement and section snapshots. Export JSON from Baselines; export readable Markdown with “Export for AI”.
- The Asteroids project is implemented independently in `../asteroids/`. Its only contract is the exported requirements baseline. No game engine or game runtime is imported here.
- Evidence contains `baseline`, `artifactUrl`, `summary`, and `checks` with `id` (requirement ID), `title`, `passed`, and `detail`. Evidence is linked to the baseline tested; future revisions do not silently inherit it.
- Browser WebMCP tools expose the same read, section, requirement, and baseline operations as the interface where supported.

AI implementation in this delivery was performed by Codex from the exported baseline. The platform does not pretend to run a background code-generation service. New prose requirements require another implementation pass in the separate project.

## Validation

```sh
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

Source: `app/page.tsx`, `app/api/workspace/route.ts`, `lib/requirements.ts`, `db/workspace.ts`. The frontend uses the bundled accessible UI primitives. Generated D1 migrations live in `drizzle/`.
