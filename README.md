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

### Snapshot implementation references (CP-004 / Wonderworks BL-005)

Applied proposals show **First included in** using the existing `appliedSnapshot` and `appliedVersion` recorded during atomic application. The link opens that exact frozen snapshot; snapshot details link back to proposals first included there. Draft, Proposed and Rejected proposals show **Not yet included**. Applied legacy proposals without an available saved target show **First included snapshot unknown**, retain their original reference, and never infer inclusion from matching content or a later snapshot.

Snapshot details have an **Implementation commit** editor with add, replace, copy, cancel and explicit clear. Commit IDs trim surrounding whitespace, normalize to lowercase, and require 40 or 64 hexadecimal characters. An optional commit URL must be absolute HTTPS, at most 2048 characters, without credentials. An optional repository must belong to this project. Its identity, name, URL and branch are captured when linked; subsequent repository renames/removal leave the recorded context intact. Edits retaining that same association retain the captured context, even after removal. A removed repository cannot be newly assigned to another snapshot. No provider URL is invented or remote commit existence checked.

A proposal derives its commit from its first-included snapshot. The same commit may be recorded on several snapshots; recording one on a later snapshot never retargets an earlier proposal. These are user-recorded references, separate from requirement status, acceptance dates and passing verification.

`snapshotImplementations` stores current references and append-only before/after corrections outside frozen baselines. Corrections record server time and trusted actor when available (otherwise explicitly unknown), appear in recent Activity, and remain available through snapshot details after the 500-entry Activity cap. Workspace imports ignore supplied association metadata and preserve the existing authoritative metadata/history. Frozen snapshots and JSON exports remain exact. No migration or read-time backfill is required.

The MCP catalog has 18 tools. `list_snapshots` adds `implementation_commit` (explicit null when empty), `implementation_updated_at`, and `implementation_actor`. `get_snapshot` returns its unchanged `snapshot` plus separate `associations` with those fields and `first_included_proposals`. Proposal list/detail responses add `first_included` with `state: known | not_yet_included | unknown`, the resolved snapshot identity/version or null, `original_snapshot_id`, and derived implementation metadata. Existing proposal fields, review outcomes, diffs and conflicts remain available.

`set_snapshot_implementation` requires `project_id`, `baseline_id`, `expected_workspace_version`, `idempotency_key`, and `implementation_commit`. A non-null object contains `commit_id` and optional `repository_id` and `commit_url`. **It replaces the entire reference: omitted optional fields are removed.** Explicit null clears; omitting `implementation_commit` is invalid. The UI preserves unchanged optional fields during editing. Successful responses return project/snapshot identity, current implementation metadata, both versions and a correlation ID.

The application uses `POST /api/snapshot-implementation` with the same arguments, domain service and durable receipts as MCP. The endpoint inherits the existing Sites application audience boundary, checks exact same-origin requests, and bounds streamed request bodies. Meaningful writes atomically save the reference, correction, Activity, receipt and one workspace version advance. Requirement-set versions and lifecycle history are unchanged. Identical normalized values retain the current workspace version, metadata timestamp and history; they still receive a durable retry receipt. Retry identical arguments and key after an uncertain result. Stale writes return `CONFLICT`; the editor offers to reload latest while retaining unsaved input.

`GET /api/snapshot-implementation?project_id=<id>&baseline_id=<id>` returns the same snapshot/associations as MCP. Add `history=1` for correction history; the matching MCP reader is `get_snapshot_implementation_history`. Both require explicit project/snapshot IDs, return newest first, default to 50 results and accept `limit` 1–100 plus `cursor`. Cursors bind actor, project, snapshot, limit and workspace version. Malformed or mismatched cursors return `INVALID_CURSOR`; concurrent changes return `RESTART_REQUIRED`. Restart without a cursor.

Run the complete regression suite against a loopback preview:

```sh
node --import tsx --test test/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

CP-004 checks are in `test/snapshot-implementation*.test.mjs`: mixed application and reverse associations, legacy/unknown provenance, later snapshots, validation, optional field replacement, repository removal, imports, isolation, pagination, no-ops, rollback, concurrency and durable retries across real D1 worker replacement. `/verification/cp-004.json` records executed outcomes against Wonderworks BL-005, including browser verification. Local verification does not claim a hosted deployment or a remote commit check.

### Live workspace updates (CP-006 / Wonderworks BL-006)

A visible, connected project checks for saved changes every **1.5 seconds**. The check uses the explicit project ID and durable **workspace version**, so requirement edits, proposal staging/submission/application, evidence, repository links and snapshot implementation metadata all become visible. All dependent views, including open requirement and commit-correction histories, derive from the same authoritative workspace revision. Current requirements remain separate from staged proposals; historical snapshots retain their frozen content.

`GET /api/workspace?project=<id>&since=<workspace_version>` performs an indexed D1 version read. An unchanged version returns **304 with no body**; a changed version returns a complete workspace from the normal read path. Both use `Cache-Control: no-store`. Invalid versions return 400 and unknown projects return 404. The endpoint retains the existing Sites audience boundary. It uses no process-local notifications, subscription registry, schema changes or write-path hooks, and works across Workers. Polling cannot accept partial or rolled-back saves. Synchronization never advances saved versions or creates activity.

One synchronization loop owns each mounted project. Refresh requests coalesce; project changes abort old reads and discard late responses. Fetch and save results pass through the same project/version gate, preventing older or duplicate responses from replacing newer state. Failed reads retain the last workspace and its last successful sync time. Requests time out after four seconds; failures retry with jittered exponential backoff capped at **30 seconds**. Offline, online, focus and visibility events trigger immediate checks. Hidden tabs skip network checks; browser suspension and throttled background timers are outside the five-second visible-tab target. Returning to the foreground reconciles every missed version. Authentication failures, access denials and sign-in redirects stop automatic polling, show **Action required**, disable saves and offer the existing sign-in flow in another tab to retain pending input. After restoring access, focus or Retry resumes authorized reads.

Background updates preserve active views, filters, selections, dialogs and input. Deleted selections are explained without silently selecting another item. **Refresh workspace** is a recovery control and does not remount the workspace or imply a successful save. The quiet status indicator distinguishes Up to date, Reconnecting, Offline and Action required; incoming changes do not produce success toasts.

Every editor captures its project and workspace save version when opened. This applies to requirements, sections, evidence, repository links, proposal details and staged requirements, snapshot creation, and implementation references. A newer read leaves that save base unchanged. A warning exposes the latest saved content; **I reviewed latest; keep my input** deliberately reconciles the base while preserving input for a separate explicit save. Deleted targets and incompatible proposal lifecycle/base changes remain blocked with recoverable input. Review actions and open Apply confirmations retain their reviewed base and require renewed review after intervening saves. REST 409 responses include `current_workspace_version` and reconciliation guidance; the UI refreshes after rejection without closing the editor, swapping tokens, or retrying the write automatically. Existing idempotency keys are retained for uncertain implementation-reference saves. Browser assistant writes require a fresh deliberate `read_requirements` after intervening updates.

Run the normal regression suite, then the browser acceptance checks against a loopback preview:

```sh
node --import tsx --test test/*.test.mjs
node node_modules/typescript/bin/tsc --noEmit
# playwright may be installed separately; PLAYWRIGHT_ROOT can identify its module.
# CHROME_PATH optionally selects an installed Chromium/Chrome executable.
node --test test/workspace-sync.browser.mjs
```

To include the separate-Worker browser check, build the app, run a second local Wrangler process against the same `.wrangler/state` directory on another port, and supply its origin as `WONDERWORKS_SECOND_URL`. Without that variable only that check is explicitly skipped. The tests use named QA projects and reject non-loopback origins. They exercise independent browser sessions and an independently authenticated MCP client; timed updates; unchanged 304 reads; preserved input, focus, filters and edit bases; deleted targets; stale saves; proposal lifecycle changes; unseen-content review protection; pinned snapshots and live history; offline, server failure, denied-access recovery, browser suspension and project switching with delayed responses. Unit tests cover duplicate/out-of-order results, save/read races, cleanup, coalescing, hidden tabs, access cancellation and retry bounds. Existing real-D1 tests cover transactional rollback and durable retry receipts across worker replacement.

Executed outcomes and exact requirement revisions are recorded at `/verification/cp-006.json`. Timing measurements describe controlled local browser tests; simulated login/access failures do not certify hosted OAuth expiration or revocation.

### Proposal-only authoring (CP-005 / Wonderworks BL-007)

**Requirements → Working requirements** selects the latest accepted set or a saved Draft/Proposed working set. Proposal content is never overlaid on a newer accepted set. Filters, counts, dependencies and the inspector follow that selection; traceability and evidence use accepted/frozen revisions. Proposed and closed proposals are read-only. A remotely closed selection stays visible with an explicit return action.

A requirement save from the accepted view chooses a Draft or creates one. Different destination content requires an explicit comparison; absent requirements cannot be silently restored. Saving while a Draft is active targets it directly. Changes and Requirements use the same editor and persisted proposals. Deletion identifies its destination and validates the resulting dependency graph. Only reviewed Apply changes accepted requirement content or revisions; it does not automatically approve a requirement's lifecycle status.

`POST /api/proposal-authoring` accepts `project_id`, `expected_workspace_version`, `idempotency_key`, exactly one of `proposal_id` or `new_proposal: {title, description?}`, and 1–100 `operations` with the existing MCP add/edit/delete/restore schema. One D1 transaction persists creation, staged content, allocated IDs, history, workspace version and the retry receipt. After an uncertain result, retry identical arguments and key. A 409 requires inspecting and reconciling the latest source/destination; merely selecting a destination or receiving a background update never advances the edit token. The UI preserves newer input entered during a save and offers Save to a proposal / Discard / Cancel for pending navigation.

Legacy `requirements` and `delete` REST actions require an explicit project and same-project Draft `proposal_id`. `requirements` accepts 1–100 items and validates the complete final set. All individual proposal staging routes also validate final dependencies before persistence. Browser `save_requirements` requires `proposal_id`; `read_requirements` distinguishes accepted requirements from separate proposal sets. Imports may reconcile unchanged accepted content but cannot change accepted fields/revisions or forge proposal application; changed requirements must use proposal staging. Historical direct edits, snapshots, evidence and existing project data are preserved.

Run `node --import tsx --test test/*.test.mjs`, `node --test test/proposal-authoring.browser.mjs`, and the CP-006 browser suite above. Tests cover atomic rollback/retry with real D1 worker replacement, forward-reference batches, all requirement write paths, import rejection, preserved history/tags/metadata, destination conflicts and cancellation, live lifecycle changes, navigation protection, compact keyboard controls, browser tools, and overlapping save/read responses. `/verification/cp-005.json` records only executed checks against BL-007.
