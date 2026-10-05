# Deployment and workspace transfer (BL-015)

## Local SQLite

Install Node 24.x and npm on macOS or Linux. From a clean checkout:

```sh
npm ci
npm run build:standalone
npm run setup
npm start
```

Open `http://127.0.0.1:3000`. Create a project, section and Draft proposal, save a requirement, stop with Ctrl-C, and run `npm start` again. The saved project must remain. Setup is repeatable and applies pending schema initialization/upgrades without replacing product data. The app fails readiness when setup is missing; startup does not initialize a different database.

The default database is `~/.local/share/wonderworks/workspace.sqlite`. Set `WW_SQLITE_PATH` to an absolute path on local disk, and pass the same environment to setup and start. Set `WW_PORT` to change the loopback port. SQLite uses WAL, FULL synchronous writes, transactions and a two-second busy timeout. A lock failure is recoverable; an MCP caller retries with the same key and arguments. Do not use SQLite over a network filesystem or for shared multi-instance sustained writes; transfer to PostgreSQL instead.

Local mode explicitly runs as the stable `local-user` actor. It accepts only a loopback IP listener and matching public origin, verifies the peer address, and strips identity/forwarded headers. It is intended for a trusted OS account, not hostile local processes. Changing its bind address to a network interface is rejected. `WW_PROFILE=self-hosted` requires accounts and PostgreSQL; missing configuration never switches profiles.

Add `http://127.0.0.1:3000/mcp` to a local Streamable HTTP client. Initialize, list tools, and call `list_projects`, `get_project`, then `list_requirements` using the exact ID. Create a Draft with `create_proposal`, the returned workspace version and a unique idempotency key. Review in the browser. A cloud client cannot reach loopback; use the authenticated HTTPS self-hosted profile for remote clients.

## Docker with bundled PostgreSQL

Install Docker Engine/Desktop with Compose v2. The Dockerfile is a multi-stage build from the locked source and dependencies. Its final non-root Node 24 image runs compiled production output without compiling or installing at startup. Linux amd64/arm64 are intended targets; consult the release report for actually executed platforms. Tag images with the source commit and retain the resulting image digest.

Create private secrets outside source control. An example configuration is `.env.example`; replace placeholders, never commit credentials. Provision an account by passing its password through stdin:

```sh
npm ci
mkdir -p secrets
chmod 700 secrets
# Create /private/password with a password of at least 12 characters, mode 600.
npm run account -- secrets/accounts.json operator operator@example.invalid < /private/password
```

The tool saves a salted scrypt password hash and SHA-256 token hash in `accounts.json`; the initial bearer token is in `accounts.json.operator.token` with mode 600. Put at least 32 random characters in `WW_SESSION_SECRET`. Compose reads its private `.env`; populate:

```text
WW_POSTGRES_PASSWORD=<URL-safe random database password>
WW_DATABASE_URL=postgresql://wonderworks:<same-password>@database:5432/wonderworks
WW_SESSION_SECRET=<stable random secret>
WW_PUBLIC_URL=http://127.0.0.1:3000
WW_IMAGE_TAG=<source-commit>
```

The container runs as UID 1000. Make the mounted secrets directory/files readable by that UID while retaining mode 700/600 (for Linux, `sudo chown -R 1000:1000 secrets`). Keep a separate private copy under the operator's ownership for account administration. Then:

```sh
docker compose up --build -d
docker compose ps
docker compose logs migrate app
```

The database must become healthy, migrations must exit successfully, and `/health/ready` must return 200 before the app is usable. The app publishes only on loopback; PostgreSQL has no published host port. Sign in at `http://127.0.0.1:3000/login`, create a project/Draft, then `docker compose restart app` and confirm persistence. `docker compose down` retains the named volume. Rebuild/recreate the app to upgrade while keeping that volume.

## External PostgreSQL and shared network access

Use the same image with `docker compose -f compose.external.yaml up --build -d`. This file starts no database service. Supply `WW_DATABASE_URL`, `WW_PUBLIC_URL`, account/session settings, and `WW_PG_TLS=verify-full`. Mount a private CA certificate and set `WW_PG_CA_FILE=/run/wonderworks/postgres-ca.pem` when needed. Certificate verification cannot be disabled through a URL query. `WW_PG_TLS=disable` is intended only for the bundled/private local database connection.

Place an HTTPS reverse proxy in front of the loopback published application. Preserve the configured Host. Identity and Forwarded/X-Forwarded headers are never trusted; built-in accounts and bearer tokens authenticate requests at the app boundary. A non-loopback public URL must use HTTPS. Configure TLS and network reachability at the proxy; do not expose PostgreSQL. The same image accepts a new database, URL, port and account file at runtime, without rebuilding.

MCP clients use the configured origin plus `/mcp`, with `Authorization: Bearer <private-token>`. Clients must support HTTP bearer headers and Streamable HTTP. Browser sessions use an HttpOnly, SameSite=Strict cookie; HTTPS deployments also set Secure. There is no standalone Sites plugin or OAuth resource. `/integrations` shows the actual profile, URL, current tool count and protocol versions. Normal UI/REST routes require authentication; MCP protocol/catalog discovery contains no project data and data-bearing calls require identity.

To revoke a token, remove its hash from that account's `tokens` array and atomically replace the mode-600 account file. Set `allowed:false` to deny all tokens and sessions for that actor immediately. Removing the account or rotating its password hash invalidates existing sessions. Keep stable account IDs across restarts; do not remap historical identities implicitly. Browser **Sign out** revokes its durable session and clears the cookie. Session records are installation authentication data and are excluded from workspace archives. Changing `WW_SESSION_SECRET` invalidates every session; bearer tokens remain separately revocable. There are no separate project roles: every allowed account has the installation's existing shared workspace visibility.

## Runtime settings

| Variable | Contract |
| --- | --- |
| `WW_PROFILE` | `local` (default) or `self-hosted`; Sites uses its own managed runtime |
| `WW_AUTH` | `local` with local; `accounts` with self-hosted |
| `WW_HOST`, `WW_PORT` | Local default `127.0.0.1:3000`; Docker `0.0.0.0:3000` internally |
| `WW_PUBLIC_URL` | Credential-free origin; required for self-hosted; Host must match |
| `WW_SQLITE_PATH` | Local persistent file; default path above; no memory database |
| `WW_DATABASE_URL` | PostgreSQL URL, self-hosted only; no URL query options |
| `WW_PG_TLS`, `WW_PG_CA_FILE` | `verify-full` default; optional CA; `disable` for private local DB |
| `WW_ACCOUNTS_FILE` | Private mode-600 JSON `{users:[{id,email,allowed,password,tokens}]}` |
| `WW_SESSION_SECRET` | Stable private random secret of at least 32 characters |
| `WW_TOKEN_FILE`, `WW_COOKIE_FILE` | Optional private credentials used only by the backup CLI |

Standalone does not read `.openai/hosting.json`. `node --env-file=/private/wonderworks.env server/start.mjs` and `node --env-file=/private/wonderworks.env scripts/setup.mjs` load a chosen environment file. Avoid shell tracing, passwords on command lines, or dumping environment variables. Do not enable framework proxy-trust flags; configuration rejects them.

## Sites/D1

Keep `.openai/hosting.json` with logical binding `DB`, the explicitly selected Site ID, and capability `mcp`. Use the Sites plugin's supported workflow to open that existing Site, run the locked build, push source, package, save and deploy. For this installation the target is `appgprj_6ac1a1e919288191b10f125fa160853d`. An update must retain its managed database, private audience and provisioned App/plugin. Never register another Site to update it.

```sh
npm ci
npm run build:sites
```

The build copies committed Drizzle migrations into the Sites artifact. The supported publishing workflow supplies real bindings/secrets and applies migrations before activation. Record the source commit, saved version, deployment status and successful URL returned by that workflow. A failed build or migration is not a successful deployment. This profile never loads Node's PostgreSQL/SQLite adapter. For a **new installation**, explicitly register/select a new Site and use that ID/configuration; do not publish to the committed existing ID accidentally. New installations remain private unless the operator changes the audience.

In Sites, connect the existing Wonderworks App/plugin and complete managed OAuth. The plugin supplies the exact OAuth resource. Revocation and audience restrictions remain with Sites; a service bypass credential is not a user identity for MCP or archive access. No independent OAuth provider is required.

For an existing local Sites emulator, build Sites first and apply only migrations missing from its schema. Old manual-emulator setups may not have Wrangler migration bookkeeping; back up before adopting a runner. All four current files (`0000` through `0003`) are required on a fresh emulator. Ordinary local use should follow the SQLite quickstart instead.

## Complete archives, backup and transfer

Open **Project settings → Workspace backup & import** to export the selected project or all accessible projects to `.wwspace`. Capture reads every selected workspace root, storage-version root, unexpired retry receipt and import-provenance row in one database transaction. Immutable content records are fetched afterward. Unsaved forms are not captured. Exports create no baseline or history activity and do not advance versions.

Version 1 is a self-contained ZIP with `manifest.json` and `records/<sha256>.json`. The manifest names the producer, format/storage versions, archive identity/time, project IDs and committed versions, required hashes, record sizes and totals. Logical record trees preserve ordering, UTF-8 source, absent legacy fields and unknown additive keys. Equal records occur once per archive and are deflated. Original accepted/staged content, all snapshots, evidence, history/lifecycle, guidance, repository/implementation metadata, stored versions and unexpired retries are included. Deployment credentials and account/session configuration are not database workspace data and are never exported.

Limits are 32 MiB compressed, 64 MiB unique expanded records, 10,000 records, 50 projects, 32 MiB materialized per workspace, depth 64, and a 2 MiB manifest. Supported ZIP entries use STORE/DEFLATE on one disk with no encryption, extra metadata, comments or ZIP64. Duplicate/unsafe paths, missing/corrupt records, malformed logical references, unsupported versions and expansion limits are rejected. Export/download and upload/inflate use bounded chunks; materialization processes one workspace at a time. The current format is v1; no prior `.wwspace` format exists. Physical SQL dumps are not portable archives.

Upload an archive, choose **Preview archive**, inspect counts/versions/conflicts, choose projects, and confirm. An unused original ID can be restored; an existing ID can only be skipped or copied. Copy changes the live project identity while retaining internal IDs and frozen source payloads. A separate import event records source identity, archive, actor and time; the UI labels inherited assertions as imported provenance. Imported open proposals still require normal human review. Existing live projects are never overwritten or merged.

Export finishes the compressed ZIP (bounded to 32 MiB) before returning HTTP success and includes its exact Content-Length. Both the browser and backup CLI check the complete ZIP directory before offering a download or reporting backup success. A truncated download fails even if the connection ends normally. The CLI retains a failed transfer as `.partial` and leaves any previous final backup intact. Export again from the source installation; changing a truncated file's manifest cannot recover its missing records. Import still performs full manifest, checksum and relationship validation.

Capture verifies immutable records once per project across historical roots, using batches of up to eight 24-record queries. ZIP entries use per-record deflation so completed entries do not retain individual streaming-compressor buffers until the directory is written. This keeps compression memory bounded when a workspace contains thousands of records.

Staged records are not visible as projects. All selected roots and the durable import receipt publish in one transaction. Cancelling before publication leaves no visible imports; if the response is lost around commit, retry the same file/selection/operation to retrieve the original project IDs. The UI locks uncertain choices. The CLI saves its operation ID in a private adjacent `.operation` file. Keep that file with the archive until the outcome is known. Receipt keys keep their original actor/project/tool scope and expiry on exact restore. Copy receipts remain inactive source metadata; archives never authenticate a caller or replay a different actor's key.

For an administrative all-project backup of a running standalone installation:

```sh
# Self-hosted only: export WW_TOKEN_FILE=/private/accounts.json.operator.token
npm run workspace -- backup http://127.0.0.1:3000 /private/backup.wwspace
```

For Sites, export all projects through the authenticated UI, or use the same CLI with a privately supplied authorized browser cookie file (`WW_COOKIE_FILE`) and the Site HTTPS origin. Never paste credentials into logs. Keep archives mode 600 and outside Git, public files, Docker contexts and image layers.

Initialize an **empty** destination of any supported profile with the same source release. Start it but do not open the project UI first (the initial UI read creates the missing Asteroids example). Restore with an authorized destination identity:

```sh
npm run workspace -- restore-empty http://127.0.0.1:3000 /private/backup.wwspace
```

This operation validates every project and checksum before atomic publication and refuses nonempty destinations, including a concurrent project creation. D1→SQLite, SQLite→PostgreSQL, D1→PostgreSQL and reverse transfers use this logical format within the documented limits. Destination authentication credentials are always provisioned separately; retain source actor IDs only through explicit account provisioning, never from the archive. A Sites actor cannot be impersonated merely by importing their history. There is no live synchronization.

Prefer logical archives for SQLite backups. A raw SQLite backup is valid only after stopping **every** app/client using the database, performing a SQLite checkpoint or preserving the main file **together with** its WAL/journal state, and copying the full consistent file set. Copying a live `.sqlite` file alone is not a backup.

## Upgrade, health, failure and reset

Back up before upgrading. This release recognizes legacy JSON, gzip v1 and content-addressed record v2 storage, and upgrades the preceding D1/SQLite v0–v3 schema to schema 4. PostgreSQL initializes schema 4. Migrations serialize with SQLite write locks or a PostgreSQL advisory lock and commit DDL/markers transactionally. Repeated setup succeeds; newer schemas and missing columns fail readiness. Older releases must not read schema 4 imported workspaces; rollback requires stopping the app and restoring the prior backup into a separate empty database with the matching old release.

Local: stop with Ctrl-C, install locked dependencies/build the new release, run setup, then start. Compose: back up, `docker compose down`, build the chosen release and `docker compose up --build -d`; the named volume remains. External PostgreSQL uses the same sequence with `-f compose.external.yaml`. Sites uses the supported publish/deployment-status workflow and managed diagnostics.

`GET /health/live` reports process liveness; `/health/ready` checks configuration/account files, schema and database connectivity without disclosing content or connection details. Preserve the configured Host for probes. Startup logs identify profile, app/schema version and URL. Database outages return failure rather than acknowledging unsaved changes; restart/reconnect after recovery without reseeding. SQLite lock contention is bounded. Restore filesystem permissions or database availability before retrying the identical MCP/import operation. Investigate a safe correlation ID, not a private workspace dump.

Destructive replacement is separate: first take and validate a backup, stop all writers, explicitly choose and provision a new empty database/path, run setup, restore there, verify it, then change runtime configuration. Retain the previous database for rollback. Deleting a SQLite directory or `docker compose down --volumes` permanently deletes product data; these are explicit operator reset actions, never part of start, stop, setup or normal upgrade.

## Verification

`node --import tsx --test test/portability.test.mjs` checks SQLite and D1 transfer, archive corruption/limits, authentication, migration, restart receipts and atomic failure behavior. Set `WW_TEST_POSTGRES_URL` to a disposable loopback PostgreSQL database to include real PostgreSQL checks; missing PostgreSQL is a reported skip. Browser and process probes are in `test/portability.browser.mjs` and `test/standalone-process.test.mjs`. The release report lists exact executed commands, runtime/backend versions and gaps. Acceptance criteria are obligations; the presence of Compose files does not establish a container execution pass.
