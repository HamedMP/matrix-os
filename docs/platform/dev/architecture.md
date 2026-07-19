# Platform Architecture

## Overview

The platform service (`packages/platform/`) is the Matrix OS control plane. It handles Clerk authentication, customer VPS provisioning, Cloudflare routing, R2 host-bundle publication, upgrade orchestration, and platform-owned integrations. Production user runtime is VPS-native: one customer VPS per active user.

```
Vercel (private FinnaAI/matrix-os-site repository)
  |-- matrix-os.com (landing, signup/login, dashboard, admin)
  |-- Clerk auth + Inngest provisioning
  |
Cloudflare Edge
  |-- app.matrix-os.com / code.matrix-os.com
  |
  +-- Cloudflare Tunnel (outbound only from platform VPS)
      |-- api.matrix-os.com -> localhost:9000 (platform API)
      |-- app/code/*       -> localhost:9000 (auth + routing)

Platform VPS
  |-- cloudflared
  |-- platform :9000
  |-- platform Postgres
  |-- Pipedream credentials and integration routes
  |-- R2 host-bundle publisher
  +-- HTTPS proxy to customer VPS public IPs with per-host verification

Customer VPS: alice
  |-- matrix-gateway.service :4000
  |-- matrix-shell.service :3000
  |-- matrix-code.service :8787
  |-- local Postgres on 127.0.0.1:5432
  |-- /home/matrix/home
  +-- /opt/matrix/app + /opt/matrix/runtime from host bundle
```

## Components

### Database (`src/db.ts`)

Kysely with PostgreSQL. Core tables:

- **user_machines** -- one row per customer VPS. Stores Clerk identity, handle, Hetzner IDs, registration metadata, status, recovery timestamps, and routing IPs.
- **containers** -- legacy/shared-container fallback rows. This is historical/local-development compatibility, not the current production customer runtime.
- **port_assignments** -- legacy container port allocation metadata.

Factory: `createPlatformDb(connectionString)` returns a Kysely-backed platform database. All query functions take `db` as their first argument for testability.

### Customer VPS Service (`src/customer-vps.ts`)

Wraps Hetzner provisioning, cloud-init rendering, R2 metadata, and platform registration. Factory: `createCustomerVpsService(config)`.

Methods:

- `provision({ handle, clerkUserId })` -- create or return the active customer VPS row, render cloud-init, and create a Hetzner server.
- `register(token, input)` -- customer VPS callback after boot; verifies machine/server/token and marks the row `running`.
- `recover({ clerkUserId })` -- replace the active customer VPS from the latest R2 DB snapshot.
- `delete(machineId)` / `status(machineId)` -- operator lifecycle and status paths.

Customer host config:

- `MATRIX_HANDLE`, `MATRIX_CLERK_USER_ID`, `MATRIX_USER_ID`
- `DATABASE_URL=postgresql://matrix:<password>@127.0.0.1:5432/matrix`
- `PLATFORM_INTERNAL_URL` and per-host `UPGRADE_TOKEN`
- R2 prefix and credentials for backup/sync
- Host bundle URL for `/opt/matrix/app`, `/opt/matrix/runtime`, and `/opt/matrix/bin`

### Local Customer Postgres

Every customer VPS owns its own Postgres database endpoint on `127.0.0.1:5432`. The gateway reads `DATABASE_URL` from `/opt/matrix/env/host.env` or assembles it from `/opt/matrix/env/postgres.env`, then bootstraps the app data layer in that local database.

The current bootstrap starts Postgres as a single machine-local `postgres:16` service container named `matrix-postgres` with a local Docker volume. That is an implementation detail of the customer VPS; it is not the legacy model where the whole Matrix OS user runtime lived in a shared platform container.

### Host Bundle

Customer VPSes download and extract:

```text
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz.sha256
```

The bundle includes:

- `/opt/matrix/app`: gateway package, shell build, shared packages, and the bundled `home/` app template/default apps.
- `/opt/matrix/runtime`: Node, code-server, and bundled coding-agent CLIs.
- `/opt/matrix/bin`: launchers for gateway, shell, code, sync, and updates.

### App Data Layer

Gateway app storage is Postgres-backed when `DATABASE_URL` is set. On customer VPSes, that URL points to the local customer Postgres database. The gateway:

- bootstraps shared tables such as `_apps`, `_kv`, and `users`;
- registers every installed app manifest with `storage.tables`;
- creates schema-per-app tables through Kysely;
- exposes app CRUD through `/api/bridge/query`.

App processes do not receive raw `DATABASE_URL`. The app runtime strips database credentials from child-process environments; browser apps and server apps should use the bridge API for scoped access to the owner-local Postgres database.

### Platform-Owned Integrations

Pipedream credentials and provider secrets stay on the platform. Customer VPS gateways proxy integration traffic back through `PLATFORM_INTERNAL_URL`:

- public integration catalog/webhook routes use `/api/integrations`;
- user-scoped integration routes use `/internal/containers/{handle}/integrations` with the per-host `UPGRADE_TOKEN`.

Do not copy `PIPEDREAM_*`, platform DB credentials, Clerk secrets, or `PLATFORM_SECRET` into customer VPS env files.

### API Routes (`src/main.ts`)

Hono app created via `createApp({ db, customerVpsService })`. Key routes:

| Method | Path | Description |
|--------|------|-------------|
| GET | /health | Health check |
| POST | /vps/provision | Provision a customer VPS |
| POST | /vps/register | Customer VPS boot registration callback |
| POST | /vps/recover | Replace a customer VPS from backup |
| GET | /vps/:machineId/status | Get customer VPS status |
| DELETE | /vps/:machineId | Delete customer VPS server and soft-delete platform row |
| GET | /system-bundles/:imageVersion/:file | Serve host bundles from R2 |
| GET | /system-bundles/channels/:channel | Serve host-bundle channel manifests |
| GET | /social/users | List users with status |
| GET | /social/profiles/:handle | Get user profile |
| GET | /social/profiles/:handle/ai | Get AI profile |
| POST | /social/send/:handle | Send cross-instance message |
| ALL | app/code/handle domains | Resolve Clerk/handle identity and proxy to the customer VPS |

Legacy `/containers/*` routes remain for local development and old fallback paths. Do not use them for new production customer runtime.

## Data Flow

### User Signup

```
1. User visits matrix-os.com/signup
2. Clerk handles registration (choose username = handle)
3. Clerk fires user.created webhook -> Inngest
4. Inngest function calls POST /containers/provision
5. When customer VPS provisioning is enabled, platform delegates to POST /vps/provision
6. Platform inserts a user_machines row, renders cloud-init, and asks Hetzner to create the server
7. The customer VPS downloads the host bundle, starts local Postgres and Matrix services, then calls POST /vps/register
8. Platform marks the machine running; app.matrix-os.com and code.matrix-os.com route the signed-in user to it
```

### Request Routing

```
1. Browser: https://app.matrix-os.com
2. Cloudflare: resolve DNS -> tunnel to platform
3. Platform verifies Clerk/session identity
4. Platform looks up a running user_machines row
5. Platform proxies over HTTPS to https://<customer-vps-ip>:443
6. Customer nginx routes to matrix-shell, matrix-gateway, or matrix-code on localhost
```

### Updates And Backup

```
1. Platform publishes matrix-host-bundle.tar.gz and .sha256 under system-bundles/<version>/
2. New VPSes download the selected CUSTOMER_VPS_IMAGE_VERSION during cloud-init
3. Existing VPSes refresh in place with matrix-update or recovery/reprovision
4. matrix-db-backup.timer uploads hourly custom-format pg_dump snapshots to the user's R2 prefix
```

## Testing

Focused platform/customer VPS tests:

```bash
bun run test tests/platform/customer-vps.test.ts
bun run test tests/platform/customer-vps-routes.test.ts
bun run test tests/platform/customer-vps-cloud-init.test.ts
bun run test tests/platform/profile-routing-vps.test.ts
bun run test tests/platform/proxy-routing.test.ts tests/platform/ws-upgrade.test.ts
```
