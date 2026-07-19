# VPS Deployment Guide

Complete guide for deploying Matrix OS on Hetzner. Production Matrix OS is VPS-native: one VPS per user, host-level Matrix services, local owner-controlled Postgres, Cloudflare routing, R2 backups, and no user runtime containers.

## Production Rule: VPS-Native Only

Effective 2026-05-06, production user runtime is **per-user VPS only**.

- Do not deploy customer runtime by rebuilding a Docker image.
- Do not use `docker compose` or rolling container restarts as a production rollout path for user-facing Matrix OS.
- Do not put Matrix gateway, shell, code-server, or default apps inside a per-user runtime container.
- Each customer VPS must have its own local PostgreSQL database endpoint at `127.0.0.1:5432`. The current bootstrap runs this as a single local `postgres:16` service container named `matrix-postgres` with a machine-local Docker volume; it is not the legacy shared user-runtime container model.
- Build and publish the customer host bundle, refresh the target VPS in place, and restart `matrix-gateway.service`, `matrix-shell.service`, `matrix-code.service`, and related systemd units.
- Docker/Compose references in older notes are legacy/local-development history. They are not the current production route.

## Architecture

### Current Production Mode: Platform Control Plane + Customer VPSes

Matrix OS runs production users on one customer VPS per active user. The platform VPS is the control plane: it owns Clerk routing, Pipedream credentials, provisioning, R2 bundle publication, and upgrade orchestration. Each customer VPS runs Matrix shell/gateway/code under systemd with owner-controlled Postgres on the same machine. Matrix shell/gateway/code/default-app assets are not containers.

```
Internet
  |
  +-- app.matrix-os.com ----+  Clerk session -> platform resolves current user
  +-- code.matrix-os.com ---+  Clerk session -> platform resolves current user
                            |
                     Cloudflare Tunnel
                            |
                     Platform VPS
                     |
                     +-- platform :9000
                     +-- auth shell
                     +-- platform Postgres
                     +-- Pipedream credentials and integration routes
                     +-- R2 host-bundle publisher
                     |
                     +-- HTTPS proxy with per-host token
                            |
                     Customer VPS: matrix-hamedmp-...
                     |
                     +-- matrix-gateway.service :4000
                     +-- matrix-shell.service :3000
                     +-- matrix-code.service :8787
                     +-- matrix-postgres on 127.0.0.1:5432 + local data volume
                     +-- /home/matrix/home and /opt/matrix/env
```

New VPS provisions download the host bundle from R2:

```text
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz.sha256
```

The per-user Docker image path is legacy/local-development only. It is not used for production customer VPSes.

New customer and recovery creation may optionally use a validated golden VPS snapshot as a fail-closed acceleration layer. It never replaces the immutable host-bundle source of truth, owner backup flow, or clean Ubuntu fallback. See [Golden VPS Snapshots](golden-vps-snapshots.md) for lifecycle, sanitation, rollout gates, and disablement.

### Archived Legacy Shared-Container Mode

This section is historical context for old deployments only. Do not use it for new production work.

```text
Internet
  |
  +-- matrix-os.com ---------> Vercel (FinnaAI/matrix-os-site -- landing, auth, dashboard)
  |
  +-- app.matrix-os.com ----+  (session-based: Clerk JWT -> container shell)
  +-- code.matrix-os.com ---+  (session-based: Clerk JWT -> container code-server)
  +-- api.matrix-os.com ----+
  +-- legacy wildcard ------+  (archived handle-based container routing only)
                            |
                     Cloudflare Tunnel
                            |
                     Hetzner VPS (no public ports except SSH)
                     |
                     +-- cloudflared (tunnel daemon)
                     +-- platform :9000 (orchestrator + routing)
                     +-- proxy :8080 (shared Anthropic API key + cost tracking)
                     +-- matrixos-alice :4001/:3001 (legacy user container)
                     +-- matrixos-bob :4002/:3002 (legacy user container)
                     +-- ...
```

### Archived Multi-Node Container Scaling

This section is historical context for the old shared-container architecture. Production scaling is per-user VPS capacity and host-bundle rollout, not Docker worker nodes.

```text
                     Cloudflare Tunnel
                            |
                     Hetzner VPS 1 -- control plane
                     |  +-- cloudflared
                     |  +-- platform :9000 (orchestrator, routes to any node)
                     |  +-- proxy :8080
                     |  +-- matrixos-alice, matrixos-bob, ...
                     |
                     +-- private network (10.0.0.0/16)
                     |
                     Hetzner VPS 2 -- worker
                     |  +-- Docker API :2376 (TLS, private network only)
                     |  +-- matrixos-charlie, matrixos-dave, ...
                     |
                     Hetzner VPS 3 -- worker
                        +-- Docker API :2376 (TLS, private network only)
                        +-- matrixos-eve, matrixos-frank, ...
```

## Hetzner Setup

### Server Selection

For the platform control plane, size for routing, builds, platform Postgres, and Cloudflare. For customer workloads, provision a separate customer VPS per user.

| Role | Server | Specs | Notes |
|------|--------|-------|-------|
| Platform control plane | CPX31+ | 4 vCPU, 8GB RAM | Handles platform, auth shell, builds, R2 publishing, Pipedream, and routing |
| Build-heavy control plane | CPX41+ | 8 vCPU, 16GB RAM | Prefer this while building platform services and customer host bundles on the same box |
| Customer VPS | CX/CPX small | 2-3 vCPU, 2-4GB RAM | One active user per VPS; Matrix and Postgres run under host services |

Legacy shared-container capacity math is no longer used for production planning.

### Create Server

1. Hetzner Cloud Console > Servers > Add Server
2. Location: Falkenstein (fsn1) or Helsinki (hel1) -- closest to your users
3. Image: Ubuntu 24.04
4. Type: CPX21 (start small, resize later)
5. Networking: check "Private networks" (create one called `matrixos-internal`, e.g. `10.0.0.0/16`)
6. SSH Keys: add your public key
7. Name: `matrixos-cp-1` (control plane 1)

### Firewall

Create in Hetzner Cloud Console > Firewalls > Create Firewall:

**Inbound rules:**

| Protocol | Port | Source           | Description      |
|----------|------|------------------|------------------|
| TCP      | 22   | Your IP (or any) | SSH access       |

That's it. No other inbound ports. Cloudflare Tunnel is outbound-only.

**Outbound:** Allow all (default).

Apply the firewall to your server.

### Block Storage Volume (recommended)

Create a volume for persistent data (survives server rebuilds):

1. Hetzner Cloud Console > Volumes > Create Volume
2. Size: 20GB (expandable later)
3. Location: same as your server
4. Attach to: `matrixos-cp-1`
5. Mount point: `/mnt/data`

On the server:
```bash
# Hetzner auto-mounts, but verify
df -h /mnt/data

# Create data directories
mkdir -p /mnt/data/platform /mnt/data/proxy /mnt/data/users
```

Use the mounted volume for platform service data and platform Postgres. Do not add Docker Compose mounts for production customer runtime.

## Step 1: Server Setup

SSH into your Hetzner VPS:

```bash
ssh root@<your-server-ip>
```

### Clone and Build

For production, deploy platform services on the platform VPS and publish the customer VPS host bundle. Do not build a per-user Docker image for production.

```bash
git clone https://github.com/HamedMP/matrix-os.git
cd matrix-os

# Deploy from a specific tag (or stay on main)
git checkout v0.3.0

# Build the customer VPS host bundle. This bakes the public Clerk key into
# the shell bundle and packages gateway/shell/code/default apps for systemd.
set -a
source .env
set +a
./scripts/build-host-bundle.sh
sha256sum dist/host-bundle/matrix-host-bundle.tar.gz
```

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is required before building the host bundle because Next.js embeds `NEXT_PUBLIC_*` vars at build time. Without it, Clerk auth will not work in the shell UI.

## Step 2: Cloudflare Tunnel

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Authenticate and create tunnel
cloudflared tunnel login
cloudflared tunnel create matrix-os

# Copy credentials
mkdir -p /etc/cloudflared
cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/credentials.json
```

### DNS Records (Cloudflare Dashboard)

| Type  | Name | Target                         | Proxy |
|-------|------|-------------------------------|-------|
| CNAME | api  | `<tunnel-id>.cfargotunnel.com` | Yes   |
| CNAME | app  | `<tunnel-id>.cfargotunnel.com` | Yes   |
| CNAME | code | `<tunnel-id>.cfargotunnel.com` | Yes   |

Root `matrix-os.com` stays pointed at Vercel. The `app` and `code` subdomains handle session-based routing (Clerk JWT -> customer VPS). Do not create user-facing per-handle Matrix subdomains for the managed product.

## Step 3: Environment Variables

```bash
cat > /root/matrix-os/.env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
PLATFORM_SECRET=your-random-secret
CLERK_SECRET_KEY=sk_live_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
GEMINI_API_KEY=your-gemini-api-key
POSTGRES_PASSWORD=your-secure-password
EOF
```

| Variable | Where Used | Build/Runtime | Description |
|----------|-----------|---------------|-------------|
| `ANTHROPIC_API_KEY` | platform/proxy | runtime | Shared Anthropic API key for routed AI calls |
| `PLATFORM_SECRET` | platform | runtime | Bearer token for admin API auth |
| `CLERK_SECRET_KEY` | platform | runtime | Server-side Clerk JWT verification |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | host bundle | **build time** | Baked into Next.js bundle (NEXT_PUBLIC_ prefix) |
| `GEMINI_API_KEY` | platform/gateway when configured | runtime | Google Gemini API key for image/icon generation |
| `POSTGRES_PASSWORD` | postgres + platform | runtime | PostgreSQL password (default: `matrixos`) |
| `S3_ENDPOINT` / `R2_ENDPOINT` | customer VPS gateway/sync | runtime | Cloudflare R2 S3-API endpoint (see Sync Storage below) |
| `S3_ACCESS_KEY_ID` / `R2_ACCESS_KEY_ID` | customer VPS gateway/sync | runtime | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` / `R2_SECRET_ACCESS_KEY` | customer VPS gateway/sync | runtime | R2 API token secret key |
| `S3_BUCKET` / `R2_BUCKET` | customer VPS gateway/sync | runtime | R2 bucket name, default `matrixos-sync` |
| `MATRIX_HOME_MIRROR` | customer VPS gateway/sync | runtime | `true` enables three-way sync (VPS home ↔ R2 ↔ peer) |
| `PLATFORM_INTERNAL_URL` | customer VPS gateway | runtime | Base URL for platform-owned internal APIs; customer VPSes use it with their per-host token for sync and integrations |

**Build-time vs runtime**: `NEXT_PUBLIC_*` vars are embedded into the Next.js JavaScript bundle during `next build`. They must be available when building the customer host bundle. Runtime vars for customer VPSes live in `/opt/matrix/env/host.env`, `/opt/matrix/env/r2.env`, and host systemd environment files.

### Platform-Owned Integrations

Pipedream integration credentials stay only on the platform process. Do not copy `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, or `PIPEDREAM_PROJECT_ID` into customer VPS host env files.

Customer VPS gateways proxy integration traffic back to the platform:

- Public catalog/webhook routes use `${PLATFORM_INTERNAL_URL}/api/integrations`.
- User-scoped integration routes use `${PLATFORM_INTERNAL_URL}/internal/containers/{handle}/integrations` with the per-host `UPGRADE_TOKEN`.
- Existing VPSes provisioned before this wiring need `PLATFORM_INTERNAL_URL=https://app.matrix-os.com` added to `/opt/matrix/env/host.env`, then `systemctl restart matrix-gateway.service`.

Smoke checks:

```bash
curl -fsS http://127.0.0.1:4000/api/integrations/available

TOKEN="$(grep '^UPGRADE_TOKEN=' /opt/matrix/env/host.env | cut -d= -f2-)"
HANDLE="$(grep '^MATRIX_HANDLE=' /opt/matrix/env/host.env | cut -d= -f2-)"
curl -fsS \
  -H "Authorization: Bearer $TOKEN" \
  "https://app.matrix-os.com/internal/containers/$HANDLE/integrations"
```

The second check should return `[]` for a user with no connected services, not `404`. It also lazily ensures the platform integrations DB has a user row for migrated VPS users.

### Sync Storage (Cloudflare R2)

The file-sync subsystem (spec 066) uses S3-compatible object storage. In prod the target is Cloudflare R2, one shared bucket, prefix-isolated per user at the gateway level.

#### One-time: provision R2

1. Cloudflare dashboard → **R2** → **Create bucket**.
   - Name: `matrixos-sync`
   - Location: auto (Cloudflare picks closest region)
   - Storage class: Standard
2. Still in R2 → **Manage R2 API Tokens** → **Create API Token**.
   - Permissions: *Object Read & Write*
   - Specify bucket: `matrixos-sync` (scope the token to this bucket only)
   - TTL: leave empty (never expires) unless you rotate regularly
3. Copy three values from the token modal before closing it:
   - `Access Key ID`
   - `Secret Access Key`
   - `S3 API` endpoint — looks like `https://<account-id>.r2.cloudflarestorage.com`

#### Append to `.env` on the VPS

```bash
cat >> /root/matrix-os/.env << 'EOF'
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=<access-key-from-step-3>
S3_SECRET_ACCESS_KEY=<secret-key-from-step-3>
S3_BUCKET=matrixos-sync
S3_FORCE_PATH_STYLE=false
MATRIX_HOME_MIRROR=true
EOF
```

Replace the placeholders with the real values. `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT` are the same URL in prod — the split exists for dev where gateway reaches MinIO at `minio:9000` internally but presigned URLs need `localhost:9100` (see `docs/dev/sync-testing.md`).

#### How env vars reach customer VPSes

Customer VPSes get machine-specific env through cloud-init and `/opt/matrix/env/host.env` plus `/opt/matrix/env/r2.env`. The host env includes `PLATFORM_INTERNAL_URL`, `UPGRADE_TOKEN`, `MATRIX_HANDLE`, `DATABASE_URL`, and R2 prefix metadata. It must not include platform-only secrets like `PIPEDREAM_CLIENT_SECRET`. Platform-owned integration routes stay on the platform and are reached from the customer VPS gateway through `PLATFORM_INTERNAL_URL`.

After editing platform `.env`, restart platform services on the platform VPS. After editing a customer VPS env file, restart that VPS's host services:

```bash
sudo systemctl restart matrix-gateway.service matrix-shell.service matrix-code.service
```

Verify the target customer VPS has the expected env:

```bash
sudo systemctl show matrix-gateway.service --property=Environment
sudo grep -E '^(PLATFORM_INTERNAL_URL|UPGRADE_TOKEN|MATRIX_HANDLE|DATABASE_URL)=' /opt/matrix/env/host.env
sudo grep -E '^(S3_|R2_)' /opt/matrix/env/r2.env
```

#### Verify R2 upload round-trip

```bash
# On the customer VPS, force home-mirror to push a file:
sudo -u matrix sh -c 'echo test > /home/matrix/home/r2-smoke.md'
sleep 5

# The manifest should list it:
TOKEN="$(sudo grep '^UPGRADE_TOKEN=' /opt/matrix/env/host.env | cut -d= -f2-)"
wget -qO- http://127.0.0.1:4000/api/sync/manifest \
  --header="Authorization: Bearer $TOKEN" | grep r2-smoke

# And the object should exist in Cloudflare:
# Open dashboard → R2 → matrixos-sync → Objects → search "r2-smoke"
```

If manifest shows the file but R2 dashboard doesn't, check gateway logs for `SignatureDoesNotMatch` (bad key) or `NoSuchBucket` (wrong bucket name / typo in `S3_BUCKET`).

#### Rotating R2 credentials

1. Cloudflare → R2 → API Tokens → create a new token.
2. Update `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` or `R2_ACCESS_KEY_ID` + `R2_SECRET_ACCESS_KEY` in `/opt/matrix/env/r2.env` on each affected customer VPS.
3. Restart the affected VPS host services with `sudo systemctl restart matrix-gateway.service matrix-sync-agent.service matrix-db-backup.timer`.
4. Revoke the old token in the Cloudflare dashboard.

## Step 4: Start the Platform

```bash
# Production platform services run on the platform VPS under systemd.
# Use the platform service units for the host, not docker compose.
sudo systemctl restart matrix-platform.service matrix-auth-shell.service cloudflared.service
sudo systemctl status matrix-platform.service matrix-auth-shell.service cloudflared.service
```

## Archived Legacy Docker Compose Bootstrap

Legacy Docker Compose deployment notes below this point are archived for old shared-container installations only. Do not use these commands for hamedmp or any production per-user VPS.

```bash
cat > distro/docker-compose.override.yml << 'EOF'
services:
  postgres:
    volumes:
      - /mnt/data/postgres:/var/lib/postgresql/data
  platform:
    volumes:
      - /mnt/data/platform:/data
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/data/users:/data/users
  proxy:
    volumes:
      - /mnt/data/proxy:/data
EOF
```

Then start with both files:
```bash
docker compose \
  -f distro/docker-compose.platform.yml \
  -f distro/docker-compose.override.yml \
  up -d
```

### Verify

```bash
curl http://localhost:9000/health   # {"status":"ok"}
curl http://localhost:8080/health   # {"status":"ok"}

# Via Cloudflare (after DNS propagation)
curl https://api.matrix-os.com/health
```

## Step 5: Vercel + Clerk + Inngest

### Vercel Environment Variables

| Variable                            | Value                         |
|------------------------------------|-------------------------------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_...`                 |
| `CLERK_SECRET_KEY`                  | `sk_live_...`                 |
| `INNGEST_EVENT_KEY`                 | (from Inngest dashboard)      |
| `INNGEST_SIGNING_KEY`               | (from Inngest dashboard)      |
| `PLATFORM_API_URL`                  | `https://api.matrix-os.com`   |

### Clerk Configuration

1. Create app at clerk.com
2. URLs: sign in `/login`, sign up `/signup`, after both `/dashboard`
3. Enable **Username** field (used as Matrix OS handle)
4. Webhooks: URL `https://matrix-os.com/api/inngest`, events `user.created` + `user.deleted`, Inngest template
5. Admin: set `publicMetadata.role = "admin"` on your user

### User Flow

```
1. matrix-os.com -> Clerk signup (choose handle)
2. Clerk webhook -> Inngest -> POST api.matrix-os.com/containers/provision
3. Platform: with CUSTOMER_VPS_ENABLED=true, create/reuse the user's single active customer VPS
4. Dashboard: "Open Matrix OS" -> https://app.matrix-os.com
5. app.matrix-os.com -> platform reads Clerk session cookie -> resolves user -> proxy to that VPS
6. code.matrix-os.com -> same Clerk session -> proxy to the user's VPS code gateway
```

`/containers/provision` remains the onboarding compatibility endpoint because the Clerk/Inngest flow already calls it. When `CUSTOMER_VPS_ENABLED=true`, it delegates to customer VPS provisioning and returns `runtime: "customer_vps"` with the machine status instead of creating a legacy Docker container. The customer VPS table has a partial unique index on active `(clerk_user_id, runtime_slot)`, so repeated onboarding calls reuse the same active VPS for that user and slot.

**Routing modes:**
- `app.matrix-os.com` -- session-based default computer. Platform extracts Clerk JWT from cookie/auth header and proxies to the user's primary active VPS. Plain `/` must not depend on a sticky staging/runtime cookie.
- `app.matrix-os.com/runtime` -- switch-computer picker. It lists the signed-in user's active VPSes with handle, slot, bundle version, status, CPU, RAM, and disk strength.
- `app.matrix-os.com/vm/<handle>` -- explicit computer route. Use this for test VMs and bookmarks. The platform verifies that `<handle>` belongs to the signed-in Clerk user, proxies the named VPS, and keeps API/WebSocket calls on that computer without changing where plain `/` lands.
- `code.matrix-os.com` -- session-based. Same identity lookup as `app.matrix-os.com`, but proxies to the user's VPS code gateway. No handle, SSH, or server IP is exposed.

### Feature Test VMs

For breaking features, onboarding changes, shell routing changes, migrations, or
anything that might corrupt a user's working desktop, prefer a disposable test
VM over testing on the user's primary VPS. Ask before creating a billable VPS
unless the user has explicitly requested it, name the VM clearly, and always
offer to delete it after validation to avoid extra Hetzner charges.

Provision a separate runtime slot for the same Clerk user and use the same login
to switch:

```bash
curl --fail --silent --show-error \
  -X POST "$PLATFORM_PUBLIC_URL/vps/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"clerkUserId":"user_xxx","handle":"alice-staging","runtimeSlot":"staging"}'
```

Open `https://app.matrix-os.com/runtime` to switch computers, or go directly to
`https://app.matrix-os.com/vm/alice-staging`. Open
`https://app.matrix-os.com/` to return to the default primary computer. Do not
use `?runtime=staging` as the durable test link; it is request-scoped only and
must not make staging sticky on plain `/`.

Deploy branch host bundles to the test VM by exact version; do not use
`/vps/deploy` unless you intend to fan out to every running VPS. Verify the VM
before handing it to a tester:

```bash
curl --fail --silent --show-error \
  "$PLATFORM_PUBLIC_URL/vps/<machineId>/status" \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

When testing is done, ask the user whether to delete the test VM. If they
approve, delete it through the platform so provider cleanup and deletion
metadata stay consistent:

```bash
curl --fail --silent --show-error \
  -X DELETE "$PLATFORM_PUBLIC_URL/vps/<machineId>" \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

If the staging VPS needs to be replaced, recover the same slot explicitly so the
primary runtime remains untouched:

```bash
matrixctl recover user_xxx --slot staging --allow-empty
```

Legacy fallback code may exist only to keep historical records reachable during migration. New and production customer runtime should not be provisioned as containers.

## Archived Legacy Container Management

This section documents the legacy shared-container API and direct Docker operations. `/containers/provision` is still the compatibility entry point for onboarding; with `CUSTOMER_VPS_ENABLED=true` it delegates to customer VPS provisioning and returns `runtime: "customer_vps"`.

### Admin Dashboard

`https://matrix-os.com/admin` (requires Clerk `publicMetadata.role = "admin"`).

### API

```bash
BASE=https://api.matrix-os.com  # or http://localhost:9000

# List all
curl $BASE/containers

# Get one
curl $BASE/containers/alice

# Provision
# With CUSTOMER_VPS_ENABLED=true this creates/reuses the user's single active VPS.
# Without it, this creates the legacy Docker container.
curl -X POST $BASE/containers/provision \
  -H "content-type: application/json" \
  -d '{"handle":"alice","clerkUserId":"user_123"}'

# Start / Stop
curl -X POST $BASE/containers/alice/start
curl -X POST $BASE/containers/alice/stop

# Destroy
curl -X DELETE $BASE/containers/alice

# Filter
curl "$BASE/containers?status=running"
```

### Docker (direct)

Direct Docker commands apply to legacy shared-container users only. Customer VPS-hosted users are inspected through SSH/systemd on their own VPS.

```bash
docker ps --filter "name=matrixos-"          # list user containers
docker logs matrixos-alice -f                 # logs
docker exec -it matrixos-alice sh             # shell into container
docker stats --filter "name=matrixos-"        # resource usage
```

### Container Lifecycle

Legacy shared-container lifecycle:

- **Provision**: image pulled, ports allocated, volume mounted at `/data/users/{handle}/matrixos`
- **Running**: 256MB memory, 0.5 CPU, restart unless-stopped
- **Idle**: lifecycle manager checks every 5 min, stops after 30 min inactive
- **Wake**: `app.matrix-os.com` request -> platform resolves the signed-in user -> detects stopped runtime -> auto-starts -> proxies
- **Destroy**: container removed, ports released, DB record deleted (data volume kept)

## Database

```bash
# Access platform DB
psql "$PLATFORM_DATABASE_URL"

# Useful queries
SELECT handle, status, port, shell_port, last_active FROM containers;
SELECT * FROM port_assignments;
SELECT status, COUNT(*) FROM containers GROUP BY status;
```

## Updating

### Update Platform Control Plane

```bash
cd matrix-os
git pull origin main
pnpm install --frozen-lockfile
bun run typecheck
sudo systemctl restart matrix-platform.service matrix-auth-shell.service cloudflared.service
sudo systemctl status matrix-platform.service matrix-auth-shell.service cloudflared.service
```

Customer VPS host services are not affected by a platform control-plane restart. Deploy customer-facing shell/gateway/default-app changes with the host-bundle path below.

### Update Customer VPS Host Bundle

Customer VPSes boot from a host bundle downloaded from R2 at:

```text
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz
system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/matrix-host-bundle.tar.gz.sha256
```

Use this path whenever shell, gateway, bundled apps, host scripts, Postgres env wiring, or agent CLI versions change for VPS-hosted users. The normal path is the GitHub Actions release workflow on `main`; local builds are for break-glass verification or emergency release preparation.

```bash
set -a
source .env
set +a

# Fails fast if NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is missing.
./scripts/build-host-bundle.sh

sha256sum dist/host-bundle/matrix-host-bundle.tar.gz
```

Publish with `./scripts/publish-release.sh <version> --channel <channel>` or let `.github/workflows/host-bundle-release.yml` do it on `main`. The publish step uploads immutable R2 objects and registers the release in platform Postgres; platform Postgres is the source of truth for release metadata and channel pointers.

Existing VPSes update through platform fan-out:

```bash
curl --fail --silent --show-error \
  -X POST https://app.matrix-os.com/vps/deploy \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"version":"v2026.05.12-43"}'
```

Do not SSH-copy bundles except for break-glass recovery. The sync agent downloads the registered bundle through platform, verifies the SHA-256, stages extraction, keeps `/opt/matrix/app.rollback`, swaps `/opt/matrix/app`, writes `/opt/matrix/release.json`, and restarts services.

Operational rules:

- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is build-time, not runtime. If the browser tries to load `https://clerk.example.com/...`, the served shell bundle was built with the placeholder Clerk key and must be rebuilt with the real key.
- `DATABASE_URL` must exist in `/opt/matrix/env/host.env` or be assembled by `/opt/matrix/bin/matrix-gateway` from `/opt/matrix/env/postgres.env`. Without it, gateway state can drift away from owner-controlled Postgres.
- Do not use `owner: root:matrix` in cloud-init `write_files` before the `matrix` group exists. Prefer `root:root` for env files unless the file must be group-readable.
- During in-place refreshes, wrapper scripts in `/opt/matrix/bin` must be executable by the `matrix` service user. Either keep bundle wrapper mode `0755`, or set group to `matrix` and mode `0750` after extraction.
- Global agent CLI packages under `/opt/matrix/runtime/node/lib/node_modules` and their shims under `/opt/matrix/runtime/node/bin` must be writable by the `matrix` group. Codex, Claude, opencode, pi, and uv update themselves through the Matrix runtime prefix; root-owned, non-writable global packages cause `EACCES: permission denied, rename ...`. Hermes installs for the `matrix` user through `/opt/matrix/bin/matrix-install-hermes`.
- Preserve `/opt/matrix/env`, `/home/matrix/home`, and the local Postgres data directory during in-place refreshes.
- Host bundle sync may replace `/opt/matrix/app` only. It must not overwrite owner files under `/home/matrix/home`; protected template paths such as `system/desktop.json`, `system/theme.json`, `system/wallpapers/`, `system/icons/`, configs, layouts, sessions, logs, conversations, memory, and state are user data.
- Record the checksum/release version after publishing and mention which customer VPSes were refreshed.

Verification after deploying a host bundle:

```bash
cat /opt/matrix/app/BUNDLE_VERSION
cat /opt/matrix/release.json
systemctl is-active matrix-gateway matrix-shell matrix-sync-agent
curl -fsS http://127.0.0.1:4000/health

source /opt/matrix/env/host.env
curl -fsSI \
  -H "Authorization: Bearer $UPGRADE_TOKEN" \
  -H "X-Platform-User-Id: $MATRIX_CLERK_USER_ID" \
  http://127.0.0.1:3000

curl -fsS \
  -H "Authorization: Bearer $UPGRADE_TOKEN" \
  -H "X-Platform-User-Id: $MATRIX_CLERK_USER_ID" \
  http://127.0.0.1:3000 | grep -q clerk.example.com && echo bad || echo no_example_clerk
```

### Deploy from Tag

```bash
git fetch --tags
git checkout v0.3.0
set -a
source .env
set +a
./scripts/build-host-bundle.sh
sha256sum dist/host-bundle/matrix-host-bundle.tar.gz
```

Publish with `./scripts/publish-release.sh <version> --channel <channel>`, then trigger `/vps/deploy` for the tested version or promoted channel. Manual SSH extraction is reserved for break-glass recovery.

## Archived Legacy Horizontal Scaling

This section is retained only for old shared-container design history. Production scaling is one VPS per user plus host-bundle rollout; do not add Docker worker nodes for customer runtime.

### How It Works

```
Control plane (VPS 1):
  - Runs platform, proxy, cloudflared
  - Connects to local Docker AND remote Docker APIs
  - DB tracks which node hosts which container
  - Routes requests to the correct node

Workers (VPS 2, 3, ...):
  - Run Docker only
  - Expose Docker API on private network (TLS-secured)
  - No public ports, no platform services
  - Just run user containers
```

The key code change: the orchestrator's `docker` client becomes a map of `nodeId -> Dockerode` instances. The `containers` table gets a `node_id` column. Provisioning picks the node with the most free capacity.

### Step 1: Create Worker Server

1. Hetzner > Add Server (same location, same private network `matrixos-internal`)
2. Name: `matrixos-worker-1`
3. Apply the same firewall (SSH only)

### Step 2: Set Up Docker TLS on Worker

On the worker, configure Docker to accept remote API connections over TLS on the private network:

```bash
# On worker: generate TLS certs
mkdir -p /etc/docker/tls
cd /etc/docker/tls

# CA
openssl genrsa -out ca-key.pem 4096
openssl req -new -x509 -days 3650 -key ca-key.pem -sha256 -out ca.pem \
  -subj "/CN=matrixos-docker-ca"

# Server cert (use private IP)
WORKER_PRIVATE_IP=10.0.0.x  # from Hetzner private network
openssl genrsa -out server-key.pem 4096
openssl req -new -key server-key.pem -out server.csr \
  -subj "/CN=$WORKER_PRIVATE_IP"
echo "subjectAltName=IP:$WORKER_PRIVATE_IP,IP:127.0.0.1" > extfile.cnf
openssl x509 -req -days 3650 -in server.csr -CA ca.pem -CAkey ca-key.pem \
  -CAcreateserial -out server-cert.pem -extfile extfile.cnf

# Client cert (copy to control plane)
openssl genrsa -out client-key.pem 4096
openssl req -new -key client-key.pem -out client.csr \
  -subj "/CN=matrixos-platform"
echo "extendedKeyUsage=clientAuth" > client-extfile.cnf
openssl x509 -req -days 3650 -in client.csr -CA ca.pem -CAkey ca-key.pem \
  -CAcreateserial -out client-cert.pem -extfile client-extfile.cnf

# Configure Docker daemon
cat > /etc/docker/daemon.json << EOF
{
  "hosts": ["unix:///var/run/docker.sock", "tcp://$WORKER_PRIVATE_IP:2376"],
  "tls": true,
  "tlsverify": true,
  "tlscacert": "/etc/docker/tls/ca.pem",
  "tlscert": "/etc/docker/tls/server-cert.pem",
  "tlskey": "/etc/docker/tls/server-key.pem"
}
EOF

systemctl restart docker
```

### Step 3: Copy Client Certs to Control Plane

```bash
# From control plane:
mkdir -p /etc/docker/workers/worker-1
scp worker-1:/etc/docker/tls/ca.pem /etc/docker/workers/worker-1/
scp worker-1:/etc/docker/tls/client-cert.pem /etc/docker/workers/worker-1/
scp worker-1:/etc/docker/tls/client-key.pem /etc/docker/workers/worker-1/
```

### Step 4: Build Image on Worker

The worker needs the Matrix OS image too:

```bash
# On worker:
git clone https://github.com/HamedMP/matrix-os.git
cd matrix-os && git checkout v0.3.0
docker build -t matrix-os:latest -f Dockerfile .
```

Or push to a private registry and pull from there.

### Step 5: Platform Code Changes

The orchestrator needs a `nodes` table and multi-host Docker support. This is a future code change (not implemented yet), but the design is:

**DB schema addition:**
```sql
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,          -- 'local', 'worker-1', 'worker-2'
  host TEXT NOT NULL,            -- 'local' or '10.0.0.x:2376'
  capacity_mb INTEGER NOT NULL,  -- total RAM for containers
  used_mb INTEGER DEFAULT 0,
  status TEXT DEFAULT 'active'
);

-- Add to containers table:
ALTER TABLE containers ADD COLUMN node_id TEXT DEFAULT 'local';
```

**Orchestrator change:**
```typescript
// Instead of one Docker client:
const docker = new Dockerode();

// Map of node -> client:
const nodes = new Map<string, Dockerode>();
nodes.set('local', new Dockerode());
nodes.set('worker-1', new Dockerode({
  host: '10.0.0.x',
  port: 2376,
  ca: readFileSync('/etc/docker/workers/worker-1/ca.pem'),
  cert: readFileSync('/etc/docker/workers/worker-1/client-cert.pem'),
  key: readFileSync('/etc/docker/workers/worker-1/client-key.pem'),
}));

// Provisioning picks least-loaded node:
function pickNode(): string {
  // query nodes table, return node with lowest used_mb
}
```

**Routing change:**
The session/app-domain proxy already looks up `shell_port` from DB. With multi-node, it also needs the node's private IP:
```typescript
// Instead of:
fetch(`http://localhost:${record.shellPort}${path}`)

// Route to correct node:
const node = getNode(record.nodeId);
const host = node.id === 'local' ? 'localhost' : node.host.split(':')[0];
fetch(`http://${host}:${record.shellPort}${path}`)
```

### Scaling Checklist

- [ ] Add `nodes` table to platform DB schema
- [ ] Add `node_id` column to `containers` table
- [ ] Update orchestrator to accept multiple Docker hosts
- [ ] Add node selection logic (least-loaded)
- [ ] Update session/app-domain proxy to route to correct node IP
- [ ] Add `/nodes` admin API endpoints (register, deregister, status)
- [ ] Build image on each worker (or set up private registry)

### When to Scale

You need a second node when:
- Concurrent running containers exceed ~60% of RAM (e.g. 10+ on CPX21)
- CPU usage sustained above 80%
- You want geographic redundancy

Until then, single node is simpler and cheaper. Resize the Hetzner server (CPX21 -> CPX31 -> CPX41) before adding nodes -- vertical scaling is free of code changes.

## Proxy Architecture

Understanding the request flow is critical for debugging:

Current customer VPS route:

```
Browser -> app.matrix-os.com / code.matrix-os.com
  -> Cloudflare Tunnel -> platform :9000
    -> session-based: Clerk JWT -> running customer VPS by clerkUserId
      -> HTTPS customer VPS gateway with per-host token
        -> nginx on customer VPS
          -> matrix-shell.service :3000 for shell paths
          -> matrix-gateway.service :4000 for /api, /ws, /files, /icons
          -> matrix-code.service :8787 for code.matrix-os.com
```

Legacy shared-container route:

```
Browser -> app.matrix-os.com
  -> Cloudflare Tunnel -> platform :9000
    -> session-based: Clerk JWT -> getContainerByClerkId -> proxy
      -> http://matrixos-{handle}:3000 (Next.js shell, non-API paths)
      -> http://matrixos-{handle}:4000 (gateway, /api/*, /ws*, /files/*, /modules/*)
        -> shell proxy.ts middleware rewrites remaining API paths
          -> http://localhost:4000 (gateway inside same container)
```

**Key points:**
- Platform routes the managed shell through `app.matrix-os.com` using session-based Clerk identity.
- The session-based route auto-starts stopped containers on access
- The shell's `proxy.ts` middleware rewrites API/file/WebSocket requests to the gateway (port 4000)
- Both shell and gateway run inside the same container (started by `docker-entrypoint.sh`)
- The gateway is PID 1 (foreground); the shell is a background process
- If the shell crashes, the container stays up (gateway still running) but HTTP returns 502
- Container memory is set to 512MB (gateway + Next.js shell together need ~200-300MB)

### Clerk Auth

Clerk session cookies must work on `app.matrix-os.com` for session routing. Configure in Clerk Dashboard > Domains:
- Primary domain: `matrix-os.com`
- Cookie domain: `.matrix-os.com`

The `app.matrix-os.com` route extracts the Clerk session from either:
- `Authorization: Bearer <token>` header
- `__session` cookie

If no valid session is found, the user is redirected to `matrix-os.com/login`. If the user has no container provisioned, they are redirected to `matrix-os.com/dashboard`.

Do not add user-facing per-handle Matrix subdomains. Managed users enter through `app.matrix-os.com`.

## Observability Stack

Matrix OS ships a Grafana + Prometheus + Loki observability overlay. It runs alongside the platform services and provides metrics, log aggregation, and alerting out of the box.

### Starting the Stack

```bash
docker compose \
  -f distro/docker-compose.platform.yml \
  -f distro/observability/docker-compose.observability.yml \
  --env-file .env up -d
```

This starts four additional containers: Prometheus, Grafana, Loki, and Promtail.

### Default Ports

| Service    | Port  | Purpose                          |
|------------|-------|----------------------------------|
| Grafana    | 3200  | Dashboards and alerting UI       |
| Prometheus | 9090  | Metrics storage and queries      |
| Loki       | 3100  | Log aggregation (queried via Grafana) |

### Accessing Grafana

Open `http://<server-ip>:3200` (or via Cloudflare Tunnel if configured).

- **Anonymous access** is enabled by default (read-only Viewer role).
- **Admin login**: username `admin`, password `matrixos`.
- Data sources (Prometheus + Loki) are auto-provisioned on first start.

### Pre-built Dashboards

Three dashboards are provisioned automatically:

1. **Platform Overview** -- container count (running/stopped), total cost today, active WebSocket connections, provision success rate, request/dispatch/error rate timeseries.
2. **Container Detail** -- per-container CPU, memory, network I/O, request rate, dispatch duration percentiles, cost, and recent logs. Use the `handle` dropdown to select a container.
3. **Cost & Usage** -- daily/weekly cost trends, per-user cost breakdown, model distribution, tokens in/out, quota utilization.

### Adding Custom Dashboards

Drop a Grafana dashboard JSON file into `distro/observability/dashboards/` and restart the stack. Grafana's provisioning config watches that directory and loads any `.json` file automatically.

```bash
# Example: add a custom dashboard
cp my-dashboard.json distro/observability/dashboards/
docker compose \
  -f distro/docker-compose.platform.yml \
  -f distro/observability/docker-compose.observability.yml \
  restart grafana
```

### Alerting

Alert rules are defined in `distro/observability/alerting/rules.yml` and loaded by Prometheus at startup. Pre-configured alerts:

| Alert                  | Condition                              | Severity |
|------------------------|----------------------------------------|----------|
| ContainerOOM           | Memory > 90% of limit for 5m          | critical |
| ContainerDown          | Health check failing for 2m            | critical |
| HighCostRate           | Daily cost > $10/user                  | warning  |
| HighErrorRate          | 5xx > 5% of requests for 5m           | warning  |
| DispatchQueueBacklog   | Queue depth > 10 for 5m               | warning  |

To add or modify alerts, edit `distro/observability/alerting/rules.yml` and restart Prometheus:

```bash
docker compose \
  -f distro/docker-compose.platform.yml \
  -f distro/observability/docker-compose.observability.yml \
  restart prometheus
```

### Metrics Endpoints

Each service exposes a `/metrics` endpoint in Prometheus text format:

```bash
curl http://localhost:4000/metrics   # gateway
curl http://localhost:9000/metrics   # platform
curl http://localhost:8080/metrics   # proxy
```

Prometheus scrapes these every 15 seconds (configured in `distro/observability/prometheus.yml`).

### Logs

Promtail tails interaction logs (`~/matrixos/system/logs/*.jsonl`), activity logs (`~/matrixos/system/activity.log`), and systemd journal output for platform/customer VPS services. All logs are searchable in Grafana via the Loki data source.

## Caching and Cloudflare

### Browser Cache Headers

The gateway serves icon and image files with `Cache-Control: public, max-age=86400, immutable` and ETag headers. This means browsers cache images for 24 hours and only re-download when the ETag changes.

### Cloudflare Cache Behavior

Cloudflare sits between the browser and the origin (gateway). It has its own cache layer with important quirks:

- **Cloudflare overrides `Cache-Control` headers.** If you set `Cache-Control: no-cache` on the origin, Cloudflare may replace it with its own default `max-age=14400` (4 hours). To control Cloudflare's cache independently, use the `CDN-Cache-Control` header:
  ```
  Cache-Control: public, max-age=86400, immutable    # browser cache
  CDN-Cache-Control: public, max-age=86400           # Cloudflare edge cache
  ```
- **Cloudflare caches 404 responses.** If an icon doesn't exist yet and Cloudflare caches the 404, subsequent requests for the same URL will get 404 even after the icon is generated. Solutions: use `CDN-Cache-Control: no-store` for dynamic endpoints, or use cache-busting query params after generating new content.
- **Do not edge-cache code editor static assets while auth is fronting code-server.** `code.matrix-os.com` serves versioned code-server JS/font URLs through the platform so unauthenticated module, worker, service-worker, and font fetches do not receive auth HTML. These responses intentionally set `CDN-Cache-Control: no-store` and `Cloudflare-CDN-Cache-Control: no-store`; otherwise Cloudflare can cache a previous auth HTML response under a `.js` or `.ttf` URL and browsers will continue failing MIME/font checks after a hard reload.
- **DevTools "Disable cache" defeats all caching.** If icons appear to re-download every time, check that "Disable cache" is unchecked in browser DevTools Network tab. This checkbox forces the browser to bypass its cache entirely.

### Image Cache-Busting Strategy

- **On page load**: Use bare URLs (e.g. `/files/system/icons/app.png`) -- browser cache handles it.
- **After regeneration**: Append `?v={timestamp}` to force the browser to re-download the new version.
- **Never use `?t=Date.now()` on every load** -- this defeats caching by creating a unique URL each time.

## Troubleshooting

### Platform won't start

```bash
sudo journalctl -u matrix-platform.service -n 200 --no-pager
sudo systemctl status matrix-platform.service
psql "$PLATFORM_DATABASE_URL" -c "select 1"
```

### Tunnel not connecting

```bash
sudo journalctl -u cloudflared.service -n 200 --no-pager
sudo systemctl status cloudflared.service

# Common: credentials missing
ls /etc/cloudflared/credentials.json
```

### Shell reconnects while HTTP stays healthy

Split the incident by layer before changing runtime code: direct customer VPS
health, local platform websocket upgrade, then public `app.matrix-os.com`
websocket upgrade. Public `/ws` or `/ws/terminal/session` failures while direct
origin probes succeed usually mean the Cloudflare tunnel is wedged.

The production platform compose runs `cloudflared-watchdog`, which polls
`/vps/fleet`, selects a healthy running customer VPS, mints a short-lived
websocket token, and probes public `/ws` plus `/ws/terminal/session`. After
three consecutive public websocket failures it restarts only the Cloudflared
container through the Docker socket, then resumes probing. Tune it with:

```bash
CLOUDFLARED_WATCHDOG_INTERVAL_MS=60000
CLOUDFLARED_WATCHDOG_FAILURE_THRESHOLD=3
CLOUDFLARED_WATCHDOG_RESTART_COOLDOWN_MS=300000
```

### Customer VPS provisioning fails

```bash
sudo journalctl -u matrix-platform.service -n 200 --no-pager
psql "$PLATFORM_DATABASE_URL" -c "SELECT id, clerk_user_id, handle, status, public_ipv4, image_version, last_seen_at FROM user_machines ORDER BY created_at DESC LIMIT 20"
```

### User gets 502 Bad Gateway

For VPS-hosted users, first confirm platform routing found the expected `user_machines` row, then check the target VPS host services.

```bash
psql "$PLATFORM_DATABASE_URL" -c "SELECT handle, status, public_ipv4, last_seen_at FROM user_machines WHERE handle = 'hamedmp'"

ssh matrix@<customer-vps-ip> 'systemctl status matrix-gateway.service matrix-shell.service matrix-code.service --no-pager'
ssh matrix@<customer-vps-ip> 'journalctl -u matrix-gateway.service -u matrix-shell.service -n 200 --no-pager'
ssh matrix@<customer-vps-ip> 'ss -tlnp | grep -E ":(3000|4000|8787) "'
```

### App icons missing or not loading

Icons are generated PNGs stored in `/data/users/{handle}/matrixos/system/icons/`. Common causes:

1. **Icon not generated yet**: Check if the PNG exists on disk. If not, trigger generation:
   ```bash
   curl -X POST https://app.matrix-os.com/api/apps/{slug}/icon
   ```

2. **Module manifest has invalid icon field**: Some `module.json`/`manifest.json` files use emojis or icon names instead of file paths. The shell ignores `meta.icon` and always uses the generated PNG at `/files/system/icons/{slug}.png`. If you see 404s for emoji URLs (e.g. `%F0%9F%94%A5`), the module manifest has `"icon": "emoji"` -- this is harmless, the generated PNG will be used instead.

3. **Cloudflare cached a 404**: If the icon was requested before it was generated, Cloudflare may have cached the 404. Hard refresh (Ctrl+Shift+R) or wait for the CDN cache TTL to expire.

4. **Shell bundle not refreshed**: Icon-related shell changes require rebuilding and publishing the customer VPS host bundle, then refreshing the target VPS in place and restarting `matrix-shell.service` and `matrix-gateway.service`.

5. **Pinned dock icon stuck on fallback letter**: The `imgFailed` state in DockIcon/AppTile components needs to reset when `iconUrl` changes. If icons show a letter instead of the image after regeneration, this reset logic may be broken.

For customer VPSes, `/icons/<slug>.png` is the system-icon compatibility path. It serves the resolved icon bytes directly (png -> svg -> `game-center.png` -> `game.svg` fallback chain) with `Cache-Control: public, max-age=86400, immutable` and an ETag, so `?v={etag}` URLs cache properly. It must never respond with a redirect: an uncacheable 307 forces the browser to re-fetch every launcher icon through Cloudflare, the platform proxy, and the VPS shell proxy on each launcher open. The shell should not automatically POST `/api/apps/:slug/icon` on every missing icon, because VPS hosts may intentionally run without `GEMINI_API_KEY`; missing Gemini should return a stable fallback instead of a browser-visible 503 loop.

Default app manifests must only reference shipped icons in `home/system/icons/`. The preferred raster style is light iOS/macOS skeuomorphic app icon artwork: refined Apple-like product rendering, a bright light background, glossy ceramic/glass objects, no text/logos, no transparent background, and no separate visible icon frame baked into the artwork. Built-ins use their own concrete icons (`terminal`, `workspace`, `files`, `chat`); games use distinct concrete icons (`2048`, `backgammon`, `chess`, `minesweeper`, `snake`, `solitaire`, `tetris`) instead of sharing `game-center`; `pomodoro` uses `pomodoro-timer`, `symphony` uses `code`, and `whiteboard` uses `whiteboard`. The default-app manifest/icon tests enforce this so new VPS homes and restored user homes do not depend on runtime icon generation for first paint.

Existing VPS homes keep owner files under `/home/matrix/home/system/icons`, so a host-bundle upgrade does not overwrite older generated logos automatically. When the owner explicitly wants the current shipped icon family, run:

```bash
ssh matrix@<customer-vps-ip> 'node /opt/matrix/app/scripts/reset-shipped-icons.mjs --home /home/matrix/home --template /opt/matrix/app/home'
```

The script overwrites only shipped `.png`/`.svg` icon names, backs up changed files under `/home/matrix/home/system/icon-backups/<timestamp>/`, skips symlinks, and leaves unrelated custom icons in place.

### Browser console shows stale production bundle errors

Map repeated console errors before changing code:

| Console symptom | Likely cause | Fix |
| --- | --- | --- |
| `clerk.example.com` / `failed_to_load_clerk_js` | Shell bundle was built without the real `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. | Rebuild and republish the customer VPS host bundle with the real Clerk publishable key. |
| `GET /api/auth/ws-token 404` | Browser is still serving an old shell bundle or host shell routes were not refreshed. | Deploy the fresh host bundle, restart shell/gateway, and hard-refresh. |
| `PUT /api/canvas 410` | Legacy canvas layout persistence client is still in the served bundle. | Fresh shell bundle should no longer call `/api/canvas`; deploy and hard-refresh. |
| `HEAD /icons/*.png 404` followed by icon POST 503 | Old shell auto-generates missing icons and gateway lacks Gemini. | Use the `/icons/*` compatibility path with its stable icon fallbacks; avoid automatic POST generation. |
| `Access-Control-Allow-Origin` from origin `null` inside apps | App iframe was loaded as an opaque/file-like origin or app bridge is calling the public origin directly. | Serve apps through Matrix origin and keep bridge/API calls relative when possible; explicit allowlists only, no wildcard CORS. |
| `ERR_BLOCKED_BY_CLIENT` for Cloudflare beacon | Browser extension or privacy blocker. | Not a Matrix OS bug. |
| `SES Removing unpermitted intrinsics` | Lockdown/SES runtime notice from sandboxed app dependencies. | Usually informational unless paired with app failure. |
| MetaMask restore errors | Extension-injected provider code. | Not a Matrix OS bug unless Matrix code explicitly invoked the wallet. |

### Canvas pans while an app window is selected

Canvas panning must be gated by event target, not only by the current focus state. Wheel and pointer pan handlers should accept events only from the canvas surface, transform root, or zoom overlay. Events bubbling from a selected app window must not call `preventDefault()` and must not update pan state. Keep a regression test that dispatches a wheel event from app content while `panEnabled=true` and asserts the transform remains unchanged.

### API routes return 404 (e.g. /api/layout, /files/...)

The Next.js middleware matcher may be excluding the path. Check `shell/src/proxy.ts` matcher config. Paths ending in `.html`, `.css`, `.js` etc. are excluded by the catch-all pattern but must be explicitly included via dedicated matchers for `/files/`, `/modules/`, etc.

### User can't access instance

```bash
psql "$PLATFORM_DATABASE_URL" -c "SELECT handle, status, public_ipv4, last_seen_at FROM user_machines WHERE handle = 'hamedmp'"
curl -fsS https://app.matrix-os.com/health
ssh matrix@<customer-vps-ip> 'curl -fsS http://127.0.0.1:4000/health'
ssh matrix@<customer-vps-ip> 'curl -fsSI http://127.0.0.1:3000'
```

## Backup

### Quick Backup

```bash
# Platform + proxy DBs
pg_dump --format=custom --file=/backups/platform-$(date +%Y%m%d).dump "$PLATFORM_DATABASE_URL"
cp /mnt/data/proxy/proxy.db /backups/proxy-$(date +%Y%m%d).db

# All user data
tar czf /backups/users-$(date +%Y%m%d).tar.gz /mnt/data/users/
```

### Automated Backup Script

```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
BACKUP_DIR=/backups/matrix-os/$DATE
mkdir -p $BACKUP_DIR

pg_dump --format=custom --file=$BACKUP_DIR/platform.dump "$PLATFORM_DATABASE_URL"
cp /mnt/data/proxy/proxy.db $BACKUP_DIR/
tar czf $BACKUP_DIR/users.tar.gz /mnt/data/users/

# Keep last 30 days
find /backups/matrix-os -maxdepth 1 -mtime +30 -exec rm -rf {} +

echo "Backup complete: $BACKUP_DIR"
```

Add to cron:
```bash
echo "0 3 * * * /root/matrix-os/scripts/backup.sh" | crontab -
```

## Migrating Platform Postgres To Managed Postgres

The current Docker platform stack owns the canonical `matrixos_platform` database
until Cloud Run proves it can see the same users, machines, and host-bundle
release metadata. Do not promote Cloud Run or stop `distro-platform-1` while the
candidate `/vps/fleet` is empty or `/system-bundles/releases` has no rows.

Use the guarded manual workflow:

```bash
gh workflow run "Platform DB Migration" \
  --repo HamedMP/matrix-os \
  --ref main \
  -f environment=staging \
  -f mode=verify
```

If the verify run can read the Docker source and the managed target, run the
restore with the exact confirmation phrase:

```bash
gh workflow run "Platform DB Migration" \
  --repo HamedMP/matrix-os \
  --ref main \
  -f environment=staging \
  -f mode=migrate \
  -f confirmation="MIGRATE PLATFORM DB TO MANAGED POSTGRES"
```

The workflow keeps a VPS-local custom-format dump under
`/home/deploy/backups/platform-migration/`, reads the managed target from the
GCP `platform-database-url` secret, restores with `pg_restore --clean
--if-exists --single-transaction`, and verifies non-zero `users`,
`user_machines`, and `host_bundle_releases` counts.

After migration:

```bash
gh workflow run "Platform Cloud Run" \
  --repo HamedMP/matrix-os \
  --ref main \
  -f environment=staging \
  -f promote=true

curl -fsS https://api.matrix-os.com/health
curl -fsS https://api.matrix-os.com/system-bundles/channels/dev.json
curl -fsS -H "Authorization: Bearer $PLATFORM_SECRET" https://api.matrix-os.com/vps/fleet
```

Docker platform can be stopped only after Cloud Run is serving 100% traffic and
the Cloud Run `/vps/fleet` output matches the Docker platform fleet. Customer VPS
Postgres databases are not part of this migration; they stay owner-local on each
VPS.

### Hetzner Snapshots

For full-server backups, use Hetzner server snapshots:
```bash
# Via hcloud CLI
hcloud server create-image matrixos-cp-1 --type snapshot --description "v0.3.0 $(date +%Y%m%d)"
```

Or enable automatic backups in Hetzner Console (~20% server cost).
