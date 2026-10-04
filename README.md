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

## Repositories, change proposals, and snapshots

Each project can link multiple Git repository web URLs with optional branch names. Links are metadata; Wonderworks does not clone repositories, read private code, or synchronize commits.

Requirement sets have their own `requirementsVersion`, independent of the workspace save counter. Existing projects start at set v1. Changes to requirements or sections advance this version; repository edits, proposal drafts, and snapshot creation do not.

Create a proposal in **Changes**, then use **Edit requirement batch** to stage additions, edits, and deletions. Staged changes are persisted separately from the latest set. Submit the batch to review field-by-field before/after differences. Reviewers can request changes, reject the proposal, or apply the entire batch. Applying advances the set version once and creates an immutable snapshot in the same database update. This remains a private workspace workflow without separate reviewer roles.

If the latest set changes during a proposal, application is blocked. **Refresh from latest** retains unrelated edits and asks the reviewer to choose proposed or latest content for overlapping requirement changes. Refresh returns the proposal to Draft so it must be submitted and reviewed again. Dependencies are validated against the complete proposed result before submission and application.

**Snapshots** preserves existing baselines and supports named snapshots, read-only inspection, and JSON export. New snapshots include requirement-set version, full requirements and sections, and repository links. Legacy baselines retain their original IDs and verification evidence; their historical set versions are not invented.

New API actions are `repository`, `repository_remove`, `proposal`, `proposal_update`, `proposal_requirement`, `proposal_delete`, `proposal_restore`, `proposal_submit`, `proposal_rebase`, and `proposal_review`. The existing `baseline` action creates a snapshot. Every mutation of an existing project still requires its last-read workspace `version`. Browser tools also expose proposal creation, staging, submission, review, and repository linking.

With the local preview running, verify the workflow using `node --test test/workflow-api.test.mjs`. These integration checks create explicitly named QA projects only in a loopback-hosted database and exercise persistence, conflict handling, atomic application, snapshot preservation, and dependency validation.

AI implementation in this delivery was performed by Codex from the exported baseline. The platform does not pretend to run a background code-generation service. New prose requirements require another implementation pass in the separate project.

## Validation

### Remote MCP (CP-001 / Wonderworks BL-002)

The Site exposes a stateless Streamable HTTP endpoint at `/mcp`. The **Connect assistant** link opens setup instructions at `/integrations`. Sites provisions the existing Site's private App/plugin and manages OAuth. Install or connect **Wonderworks** in **Plugins → Personal → Created by you**. The provisioned plugin supplies the exact MCP URL and OAuth resource; do not configure a separate OAuth provider or use the service bypass token for user MCP calls. Disconnect or revoke the connection from the assistant's plugin settings.

The current transport supports protocol revisions `2025-11-25`, `2025-06-18`, and `2025-03-26`, including `initialize`, `notifications/initialized`, `ping`, `tools/list`, and `tools/call`. GET/DELETE return 405; there are no sessions, SSE subscriptions, resources, prompts, or background jobs. Requests need `Content-Type: application/json`, `Accept: application/json, text/event-stream`, and the negotiated `MCP-Protocol-Version` after initialization. The 2026 revision is not advertised; clients must negotiate one of the supported revisions. See the [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) and [tool specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

| Tools | Scope |
| --- | --- |
| `list_projects`, `get_project` | Project identity, sections, repository metadata, workspace and requirement-set versions |
| `list_requirements`, `get_requirement` | Current requirements with search, section/status filters, and exact revisions |
| `list_snapshots`, `get_snapshot` | Metadata and exact immutable snapshots, preserving absent legacy fields |
| `list_proposals`, `get_proposal` | Review status, staged content, field differences, and base/proposed/latest conflicts |
| `create_proposal`, `update_proposal`, `stage_proposal_changes` | Persist Drafts and atomic batches of 1–100 additions, edits, deletions, or restorations |
| `submit_proposal`, `rebase_proposal` | Submit for human review or refresh onto the latest set with explicit conflict resolutions |
| `list_evidence`, `record_evidence` | Read and record baseline-specific external verification outcomes |

Every operation except `list_projects` requires `project_id`; there is no active-project fallback. List tools default to 50 results, allow 1–100, and return an opaque `next_cursor`. Reuse all query arguments with that cursor. If the workspace changes, `RESTART_REQUIRED` instructs the client to restart the list. Tool discovery contains no private workspace data.

Every write requires `expected_workspace_version` (from a fresh read) and `idempotency_key` (8–128 letters, digits, `.`, `_`, `:`, or `-`). Reuse **identical arguments and the same key** after a lost response. Durable receipts are scoped to authenticated actor, project, and tool, and retained for at least 24 hours. A replay returns the original result before checking the now-stale version; changed arguments return `IDEMPOTENCY_KEY_REUSED`. After expiry, inspect the saved object before issuing a new write. Concurrent new writes return `CONFLICT` with `current_workspace_version` instead of overwriting changes.

`stage_proposal_changes` accepts `operations`: `add` supplies `client_ref` and full `requirement` fields; `edit` supplies `requirement_id` and full fields; `delete`/`restore` supply `requirement_id`. A link such as `$foundation` resolves an addition with `client_ref: "foundation"` anywhere in the same batch. The result returns `client_refs` mapping these aliases to permanent IDs. Validation runs on the complete staged set, and a rejected batch persists neither partial changes nor reserved IDs. `rebase_proposal` accepts `resolutions: {"WW-001": "proposed"}` or `"latest"` for every current overlap.

Applying, rejecting, and requesting changes remain in **Changes** in the UI. Remote tools cannot directly edit current requirements, approve statuses, create baselines, import workspaces, or manage projects, sections, and repository links. Evidence does not change requirement status or claim the server ran the tests.

Sites dispatch enforces the existing audience and supplies trusted `oai-authenticated-user-id` and email headers. Data calls require that identity; service bypass credentials are explicitly rejected. All projects share the Site's current access boundary, rather than introducing unsupported project roles. Do not expose this Worker behind a proxy that forwards untrusted identity headers. The portable Sites middleware strips forged headers and emulates sign-in only on loopback. Origin must be absent or exactly the request origin. The body limit is 250000 UTF-8 bytes, checked while streaming. Runtime errors expose only safe messages and correlation IDs. Each successful write creates one attributable activity entry; client names from `_meta["io.modelcontextprotocol/clientInfo"].name` are untrusted reported metadata. No process-local client identity is remembered.

Apply the new `drizzle/0001_lowly_talos.sql` migration to an existing local database before testing. Production migrations are part of Sites publishing. Receipts and the workspace save use a single D1 transaction; no runtime schema creation is used.

With the local preview running:

```sh
node --import tsx --test test/mcp-api.test.mjs test/mcp-store.test.mjs test/workflow-api.test.mjs
```

The store tests use an isolated real Miniflare D1 database, force a save failure after receipt insertion, replace the worker, and verify rollback and durable retry behavior. HTTP tests cover all 15 tools, schemas, authentication rejection, stale pagination, staging, rebase, apply-and-snapshot through the existing API, mixed evidence, and concurrency. These tests create QA projects only in loopback databases.

An independent official client probe is available in `test/mcp-sdk-client.mjs`. Install `@modelcontextprotocol/sdk@1.32.0` in a separate test directory and set `MCP_SDK_ROOT` to that package's absolute path, then run `node test/mcp-sdk-client.mjs`. It verifies discovery and reads over HTTP without a browser, using only local emulated sign-in. Hosted OAuth, audience enforcement, and revocation must also be verified through the published Site plugin; local sign-in is not evidence of those hosting checks.

```sh
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

Source: `app/page.tsx`, `app/api/workspace/route.ts`, `lib/requirements.ts`, `db/workspace.ts`. The frontend uses the bundled accessible UI primitives. Generated D1 migrations live in `drizzle/`.

### Requirement tags (CP-002 / Wonderworks BL-003)

Requirements can carry up to 20 aspect tags such as `mcp`, `security`, and `reliability`. Add or reuse labels in either requirement editor. Tag chips on cards and in the inspector open the corresponding filter. The Requirements view combines exact **Any tag**, **All tags**, or **Untagged** filtering with text, status, and section filters. Text search also matches tag labels. Inventory counts apply text/status/section before the tag restriction, and switching projects clears tag selections. Tags used only in an unapplied proposal stay out of the current set's inventory.

Labels trim whitespace, lowercase ASCII letters, and turn internal whitespace into hyphens. Normalized labels contain 1–40 characters and match `[a-z0-9]+(?:-[a-z0-9]+)*`. Input is bounded to 20 entries of at most 100 raw characters each; invalid labels reject the entire save. Duplicates are removed and values sorted. Equivalent case, whitespace, duplicates, or order do not create a revision. Tags have no authorization meaning and are not assigned automatically.

Tag edits are versioned requirement content. Proposals show **Tags** before/after differences, retain normal conflict resolution, and apply with exactly one set-version advance and snapshot. A tag-only revision follows the existing revision-specific evidence rules. Current Markdown exports and new snapshot JSON include tags; old snapshots and evidence remain exact historical records.

Legacy records with no `tags` field behave as untagged without a migration or write on read. New and substantively edited requirements, new proposal copies, and new snapshots include explicit arrays. An omitted field on an edit preserves the current or staged tags; `tags: []` clears them. This applies to REST, browser tools and MCP. Reconciliation treats omitted tags and an empty set as equivalent for untagged current records but rejects omitted tags that would erase a nonempty set. Existing frozen records retain the original absence of the field.

The existing MCP catalog remains at 15 tools. `list_requirements` additionally accepts `tags`, `tag_mode: "any" | "all"` (default `any`), and `untagged_only` (default `false`). Nonempty `tags` cannot combine with `untagged_only: true`. Filtering precedes pagination; cursors bind normalized tags and all query options. Current reads return tag arrays, while historical reads preserve stored field presence. `stage_proposal_changes` accepts optional tags on additions and edits, using the omission/clear behavior above and the existing atomic, idempotent write contract.

Run the tagging and workflow checks against a loopback preview:

```sh
node --import tsx --test test/tagging.test.mjs test/tagging-api.test.mjs test/mcp-api.test.mjs test/mcp-store.test.mjs test/workflow-api.test.mjs
```

The checks cover normalization bounds, tag-only revisions/diffs, omitted fields, exact legacy snapshots, import validation, filter combinations and counts, UI/MCP filter parity, filter-bound cursors, proposal isolation and application, rebase conflicts, D1 rollback, and persisted retry receipts across worker replacement. Browser verification also exercises keyboard selection/removal, compact layouts, cancellation, validation feedback, reloads, and actual apply-and-snapshot review.

### Requirement history (CP-003 / Wonderworks BL-004)

A requirement's details now show creation, last committed change, last proposal acceptance, first/latest recorded approval, and latest recorded implementation dates. **History** opens a paginated timeline with saved before/after values, actor provenance, lifecycle transitions, and links to the exact applied proposal and snapshot. Activity, applied proposal changes, and snapshot requirements also open history, including for deleted identities. Dates include the time zone and the revision they describe; an old approval or acceptance does not describe a newer direct edit.

The append-only `requirementHistory` records are stored separately from the capped recent Activity array inside the authoritative workspace document. Both are saved with the specification in the same version-checked D1 update; MCP receipt and workspace persistence remain transactional. No schema migration is needed. Every server mutation boundary captures actual committed differences once. Proposal additions record their first successful staging time as uncommitted creation provenance; later staging, submission, rejection and rebase never create accepted revisions. Application records one event per affected identity and retains its proposal, snapshot and review note. No-op saves and idempotent retries do not duplicate events. Deleted IDs remain reserved.

Legacy dates remain unknown. Snapshot-only records supply a **first observed** date, never an invented creation/approval date. Reading metadata is pure: no backfill or rewriting of frozen exports or evidence occurs. Imported content records its local import time and revision gaps; imported history/actor/date fields are not trusted, and existing local records survive even when old clients omit them. Imported status values do not fabricate past approval or implementation transitions. A later gap preserves a first approval already established by complete local history.

`get_requirement` adds `lifecycle` and `coverage` output metadata. The read-only MCP and browser tool `get_requirement_history` accepts explicit `project_id`, `requirement_id`, optional `limit` (1–100, default 50), and `cursor`. The matching application endpoint is `GET /api/requirement-history?project_id=<id>&requirement_id=<id>`. It returns the same lifecycle/coverage, current identity or deleted/pending state, saved events newest first, and `next_cursor`. Reuse all query arguments for later pages. Cursors bind project, requirement, limit and workspace consistency state; malformed or mismatched cursors return `INVALID_CURSOR`, concurrent writes return `RESTART_REQUIRED`, unknown identities return `NOT_FOUND`. Restart without a cursor after invalidation. MCP uses the existing trusted user access boundary; the application endpoint inherits the existing Sites audience protection.

The catalog now has 16 tools. History and lifecycle are output metadata, not writable requirement fields; snapshots still contain only their exact frozen content. Events retain trusted actor IDs when available, explicitly unknown actors otherwise, and separately labeled reported client names.

Run CP-003 verification against the loopback preview:

```sh
node --import tsx --test test/requirement-history.test.mjs test/requirement-history-api.test.mjs test/requirement-history-store.test.mjs
```

These checks cover every field, lifecycle cycles, pending provenance, multi-requirement application/deletion, legacy/import gaps, immutable snapshots, >500 Activity entries, pagination, overlapping project IDs, stale and invalid writes, forced real-D1 storage failures, and durable retries across worker replacement. The versioned report at `/verification/cp-003.json` identifies the executed checks and their exact requirement baseline.
