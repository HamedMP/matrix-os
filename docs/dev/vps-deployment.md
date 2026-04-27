# VPS Deployment Guide

Complete guide for deploying Matrix OS on a Hetzner VPS. Covers: server setup, platform service, container management, Cloudflare Tunnel, horizontal scaling, and backups.

## Architecture

### Single Node (start here)

```
Internet
  |
  +-- matrix-os.com ---------> Vercel (www/ -- landing, auth, dashboard)
  |
  +-- app.matrix-os.com ----+  (session-based: Clerk JWT -> container)
  +-- api.matrix-os.com ----+
  +-- *.matrix-os.com ------+  (handle-based: {handle}.matrix-os.com -> container)
                            |
                     Cloudflare Tunnel
                            |
                     Hetzner VPS (no public ports except SSH)
                     |
                     +-- cloudflared (tunnel daemon)
                     +-- platform :9000 (orchestrator + routing)
                     +-- proxy :8080 (shared Anthropic API key + cost tracking)
                     +-- matrixos-alice :4001/:3001 (user container)
                     +-- matrixos-bob :4002/:3002 (user container)
                     +-- ...
```

### Multi-Node (scale later)

```
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

| Users    | Server | Specs              | Cost   |
|----------|--------|--------------------|--------|
| 1-20     | CPX21  | 3 vCPU, 4GB RAM    | ~5/mo  |
| 20-50    | CPX31  | 4 vCPU, 8GB RAM    | ~9/mo  |
| 50-100   | CPX41  | 8 vCPU, 16GB RAM   | ~17/mo |

Each user container is capped at 256MB RAM + 0.5 CPU. With 30-min idle timeout, most containers are stopped. A 4GB box can run ~10 concurrent users.

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

Update docker-compose to use the volume mount (see Step 4 below).

## Step 1: Server Setup

SSH into your Hetzner VPS:

```bash
ssh root@<your-server-ip>
```

### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
```

### Clone and Build

```bash
git clone https://github.com/HamedMP/matrix-os.git
cd matrix-os

# Deploy from a specific tag (or stay on main)
git checkout v0.3.0

# Build the user container image (Clerk key is baked in at build time)
docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_... \
  -t ghcr.io/hamedmp/matrix-os:latest \
  -f Dockerfile .

# Build platform services (reads build args from .env)
docker compose -f distro/docker-compose.platform.yml --env-file .env build
```

The `--build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is required because Next.js embeds `NEXT_PUBLIC_*` vars at build time. Without it, Clerk auth will not work in the shell UI.

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
| CNAME | *    | `<tunnel-id>.cfargotunnel.com` | Yes   |

Root `matrix-os.com` stays pointed at Vercel. The `app` subdomain handles session-based routing (Clerk JWT -> user container). The wildcard covers per-handle subdomains (`{handle}.matrix-os.com`).

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
| `ANTHROPIC_API_KEY` | proxy | runtime | Shared Anthropic API key for all user containers |
| `PLATFORM_SECRET` | platform | runtime | Bearer token for admin API auth |
| `CLERK_SECRET_KEY` | platform + user containers | runtime | Server-side Clerk JWT verification |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Docker image | **build time** | Baked into Next.js bundle (NEXT_PUBLIC_ prefix) |
| `GEMINI_API_KEY` | platform + user containers | runtime | Google Gemini API key for image/icon generation |
| `POSTGRES_PASSWORD` | postgres + platform | runtime | PostgreSQL password (default: `matrixos`) |
| `S3_ENDPOINT` | user containers | runtime | Cloudflare R2 S3-API endpoint (see Sync Storage below) |
| `S3_PUBLIC_ENDPOINT` | user containers | runtime | Same as `S3_ENDPOINT` for Cloudflare R2; different for MinIO |
| `S3_ACCESS_KEY_ID` | user containers | runtime | R2 API token access key |
| `S3_SECRET_ACCESS_KEY` | user containers | runtime | R2 API token secret key |
| `S3_BUCKET` | user containers | runtime | R2 bucket name, default `matrixos-sync` |
| `S3_FORCE_PATH_STYLE` | user containers | runtime | `false` for R2, `true` for MinIO |
| `MATRIX_HOME_MIRROR` | user containers | runtime | `true` enables three-way sync (container ↔ R2 ↔ peer) |

**Build-time vs runtime**: `NEXT_PUBLIC_*` vars are embedded into the Next.js JavaScript bundle during `next build`. They must be available as Docker build args. All other vars are passed at container runtime via `docker-compose.platform.yml` environment section and the orchestrator's `extraEnv` mechanism.

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

#### How the env vars reach user containers

The Platform orchestrator reads these vars from its own process env and forwards them into every per-user container via `extraEnv`. Code path: `packages/platform/src/main.ts:626–641` builds the `extraEnv` array; `packages/platform/src/orchestrator.ts:146–173` (`buildEnv`) appends it to each container's env. The gateway inside the container then reads `S3_ENDPOINT` etc. at `packages/gateway/src/server.ts:294–311` and boots the R2 client.

After editing `.env`, restart the platform + roll every user container so the new env is in effect:

```bash
docker compose -f distro/docker-compose.platform.yml --env-file .env up -d --build platform
curl -X POST http://localhost:9000/containers/rolling-restart \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

Verify one container has the vars:

```bash
CANARY=$(docker ps --filter "name=matrixos-" --format "{{.Names}}" | head -1)
docker exec $CANARY env | grep -E '^(S3_|MATRIX_HOME_MIRROR)='
# Expect all six S3_* vars + MATRIX_HOME_MIRROR=true
```

#### Verify R2 upload round-trip

```bash
# Inside a running user container, force home-mirror to push a file:
docker exec $CANARY sh -c 'echo test > /home/matrixos/home/r2-smoke.md'
sleep 5

# The manifest should list it:
docker exec $CANARY sh -c 'wget -qO- http://localhost:4000/api/sync/manifest \
  -H "Authorization: Bearer $MATRIX_AUTH_TOKEN"' | grep r2-smoke

# And the object should exist in Cloudflare:
# Open dashboard → R2 → matrixos-sync → Objects → search "r2-smoke"
```

If manifest shows the file but R2 dashboard doesn't, check gateway logs for `SignatureDoesNotMatch` (bad key) or `NoSuchBucket` (wrong bucket name / typo in `S3_BUCKET`).

#### Rotating R2 credentials

1. Cloudflare → R2 → API Tokens → create a new token.
2. Update `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY` in `.env`.
3. Restart platform + rolling-restart containers (same commands as above).
4. Revoke the old token in the Cloudflare dashboard.

## Step 4: Start the Platform

```bash
# Always pass --env-file .env (reads PLATFORM_SECRET, CLERK_SECRET_KEY, GEMINI_API_KEY, etc.)
docker compose -f distro/docker-compose.platform.yml --env-file .env up -d
```

To use the Hetzner block storage volume instead of Docker volumes, create an override:

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
3. Platform: allocate ports -> create Docker container -> start
4. Dashboard: "Open Matrix OS" -> https://app.matrix-os.com
5. app.matrix-os.com -> platform reads Clerk session cookie -> resolves user -> proxy to container
6. After 30 min idle -> container auto-stops
7. Next visit -> platform auto-wakes container
```

**Two routing modes:**
- `app.matrix-os.com` -- session-based. Platform extracts Clerk JWT from cookie/auth header, looks up container by `clerkUserId`, proxies to it. No handle in URL. Redirects to `/login` if no session.
- `{handle}.matrix-os.com` -- handle-based. Platform resolves handle from subdomain, proxies to container. No auth required (public access).

## Container Management

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

```bash
docker ps --filter "name=matrixos-"          # list user containers
docker logs matrixos-alice -f                 # logs
docker exec -it matrixos-alice sh             # shell into container
docker stats --filter "name=matrixos-"        # resource usage
```

### Container Lifecycle

- **Provision**: image pulled, ports allocated, volume mounted at `/data/users/{handle}/matrixos`
- **Running**: 256MB memory, 0.5 CPU, restart unless-stopped
- **Idle**: lifecycle manager checks every 5 min, stops after 30 min inactive
- **Wake**: subdomain request -> platform detects stopped -> auto-starts -> proxy
- **Destroy**: container removed, ports released, DB record deleted (data volume kept)

## Database

```bash
# Access platform DB
docker compose -f distro/docker-compose.platform.yml exec platform sh
sqlite3 /data/platform.db

# Useful queries
SELECT handle, status, port, shell_port, last_active FROM containers;
SELECT * FROM port_assignments;
SELECT status, COUNT(*) FROM containers GROUP BY status;
```

## Updating

### Update Platform (zero-downtime for user containers)

```bash
cd matrix-os
git pull origin main
docker compose -f distro/docker-compose.platform.yml --env-file .env up -d --build
```

User containers are NOT affected -- they keep running on the old image.

### Update User Container Image

```bash
# Rebuild image (Clerk key is baked in at build time). The helper stamps
# VERSION, MATRIX_BUILD_SHA, MATRIX_BUILD_REF, and MATRIX_BUILD_DATE into the
# image labels, env, startup logs, and /api/system/info.
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
MATRIX_TAG_LOCAL=0 MATRIX_IMAGE_TAG=ghcr.io/hamedmp/matrix-os:latest ./scripts/build-user-image.sh

# New provisions use the new image automatically.
# To update an existing container, use the upgrade API:
curl -X POST http://localhost:9000/containers/<handle>/upgrade \
  -H "Authorization: Bearer $PLATFORM_SECRET"

# Or roll every running container at once:
curl -X POST http://localhost:9000/containers/rolling-restart \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

The upgrade endpoint stops the old container, pulls the latest image, creates a new container with the same ports and volume mount, and starts it. User data in `/data/users/{handle}/matrixos` is preserved.

#### Inspect Running Container Provenance

Every user image built by `scripts/build-user-image.sh` carries build provenance:

- Docker labels: `org.opencontainers.image.revision`, `org.opencontainers.image.ref.name`, `org.opencontainers.image.created`
- Container env: `MATRIX_BUILD_SHA`, `MATRIX_BUILD_REF`, `MATRIX_BUILD_DATE`
- Gateway API: `GET /api/system/info`
- Startup logs: `docker logs matrixos-<handle> | head`

Quick inventory:

```bash
./scripts/container-versions.sh
```

For a single container:

```bash
docker exec matrixos-<handle> wget -qO- http://localhost:4000/api/system/info | jq .
docker inspect matrixos-<handle> \
  --format '{{.Config.Image}} {{range .Config.Env}}{{println .}}{{end}}' \
  | grep -E 'MATRIX_IMAGE|MATRIX_BUILD_'
```

If a row shows `unknown`, that container is running an image built before provenance stamping landed. Rebuild with `scripts/build-user-image.sh` and upgrade or rolling-restart it.

#### Deploying a locally-built image (avoiding the pull-revert trap)

**Important:** when `PLATFORM_IMAGE` points at a public registry ref like `ghcr.io/hamedmp/matrix-os:latest`, every call to `/upgrade` and `/containers/rolling-restart` runs `docker pull` on that ref. If the registry still holds an older image than the one you just built locally, **the pull will overwrite your local tag with the stale registry image** and silently deploy old code. The orchestrator guards against this by only pulling when the image ref looks remote (`host.tld/...`), but that only helps if you use a local-only tag.

The durable fix is to use a local-only tag for deploys-without-push:

```bash
# 1. Build into a local-only tag (no registry host prefix)
export NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_...
MATRIX_IMAGE_TAG=matrixos-user:$(git rev-parse --short=12 HEAD) ./scripts/build-user-image.sh

# 2. Tell the orchestrator to use it (one-time setup)
echo 'PLATFORM_IMAGE=matrixos-user:local' >> .env

# 3. Restart platform to pick up the env var
docker compose -f distro/docker-compose.platform.yml --env-file .env up -d platform

# 4. Roll all containers
curl -X POST http://localhost:9000/containers/rolling-restart \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

Because `matrixos-user:local` has no registry host, the orchestrator's `pullImageIfRemote()` helper skips the pull entirely. `docker tag <new-sha> matrixos-user:local` after each build to advance the local tag.

#### Recommended Dev / Prod Split

Run three image tracks:

- `ghcr.io/hamedmp/matrix-os:vX.Y.Z`: immutable production release. Customer containers should run this or a digest-pinned equivalent.
- `ghcr.io/hamedmp/matrix-os:canary-<sha>`: shared team dogfood. Founders' own containers can run this after tests pass, before promoting a release.
- `matrixos-user:local`: one-VPS live testing only. Never point customer containers at this tag.

On the current shared VPS, keep customer containers on released registry tags and use dedicated founder handles for canary/local testing. When moving to VPS-per-user, keep the same rule: each VPS records its desired image tag, and upgrades only replace the container image while preserving `/data/users/{handle}/matrixos`.

For team development inside Matrix itself:

1. Each founder gets their own Matrix container and home volume.
2. Code work happens in `~/projects/matrix-os` inside that container.
3. Build a local image with `scripts/build-user-image.sh`.
4. Upgrade only the founder's own dogfood container first.
5. Promote to canary after pre-PR checks pass.
6. Promote to `vX.Y.Z` only from a tagged commit.

#### Known buildx gotcha: new build, stale tag

When `docker build -t ghcr.io/owner/image:tag ...` completes, buildx occasionally writes the manifest list as a dangling `<none>` image instead of advancing the tag. Verify after every build:

```bash
docker images ghcr.io/hamedmp/matrix-os --format "{{.ID}} {{.CreatedAt}}"
```

If `CreatedAt` is the old image's timestamp, find the fresh dangling image and re-tag:

```bash
docker images --all --format "{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}" \
  | grep -E "(<none>|matrix-os)" | head
# Then:
docker tag <new-sha> ghcr.io/hamedmp/matrix-os:latest   # (or matrixos-user:local)
```

This is most reproducible when running platform and user-image builds in parallel under load.

#### Running parallel builds under load

The platform build and user-image build share 95%+ of their layers (same base image, same `pnpm install`, same Next.js compile). Running both at once on a 16GB / 8-core box with ~20 user containers already running pushes load average above 50 and roughly doubles build time (Next.js compile went from 23s to 112s in one observed case). Build sequentially unless you're on idle hardware.

### Deploy from Tag

```bash
git fetch --tags
git checkout v0.3.0
docker build \
  --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_... \
  -t ghcr.io/hamedmp/matrix-os:latest \
  -f Dockerfile .
docker compose -f distro/docker-compose.platform.yml --env-file .env up -d --build
```

## Horizontal Scaling

Start with one node, add workers when you need more capacity. No architecture change -- the platform orchestrator already abstracts container creation behind dockerode, which supports remote Docker hosts.

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
The subdomain proxy already looks up `shell_port` from DB. With multi-node, it also needs the node's private IP:
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
- [ ] Update subdomain proxy to route to correct node IP
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

```
Browser -> app.matrix-os.com (or {handle}.matrix-os.com)
  -> Cloudflare Tunnel -> platform :9000
    -> session-based: Clerk JWT -> getContainerByClerkId -> proxy
    -> handle-based: subdomain -> getContainer -> proxy
      -> http://matrixos-{handle}:3000 (Next.js shell, non-API paths)
      -> http://matrixos-{handle}:4000 (gateway, /api/*, /ws*, /files/*, /modules/*)
        -> shell proxy.ts middleware rewrites remaining API paths
          -> http://localhost:4000 (gateway inside same container)
```

**Key points:**
- Platform has two routing middlewares: `app.matrix-os.com` (session-based, Clerk JWT) and `{handle}.matrix-os.com` (handle-based, no auth)
- Both resolve to the same container -- different entry points, same destination
- The session-based route auto-starts stopped containers on access
- The shell's `proxy.ts` middleware rewrites API/file/WebSocket requests to the gateway (port 4000)
- Both shell and gateway run inside the same container (started by `docker-entrypoint.sh`)
- The gateway is PID 1 (foreground); the shell is a background process
- If the shell crashes, the container stays up (gateway still running) but HTTP returns 502
- Container memory is set to 512MB (gateway + Next.js shell together need ~200-300MB)

### Clerk Auth (subdomain cookies)

Clerk session cookies must be scoped to `.matrix-os.com` for `app.matrix-os.com` routing to work. Configure in Clerk Dashboard > Domains:
- Primary domain: `matrix-os.com`
- Cookie domain: `.matrix-os.com`

The `app.matrix-os.com` route extracts the Clerk session from either:
- `Authorization: Bearer <token>` header
- `__session` cookie

If no valid session is found, the user is redirected to `matrix-os.com/login`. If the user has no container provisioned, they are redirected to `matrix-os.com/dashboard`.

The `{handle}.matrix-os.com` route does **not** require Clerk auth -- it proxies directly based on the subdomain handle. This means handle-based subdomains are publicly accessible to anyone with the URL.

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

Promtail tails interaction logs (`~/matrixos/system/logs/*.jsonl`), activity logs (`~/matrixos/system/activity.log`), and Docker container stdout/stderr. All logs are searchable in Grafana via the Loki data source.

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
- **DevTools "Disable cache" defeats all caching.** If icons appear to re-download every time, check that "Disable cache" is unchecked in browser DevTools Network tab. This checkbox forces the browser to bypass its cache entirely.

### Image Cache-Busting Strategy

- **On page load**: Use bare URLs (e.g. `/files/system/icons/app.png`) -- browser cache handles it.
- **After regeneration**: Append `?v={timestamp}` to force the browser to re-download the new version.
- **Never use `?t=Date.now()` on every load** -- this defeats caching by creating a unique URL each time.

## Troubleshooting

### Platform won't start

```bash
docker compose -f distro/docker-compose.platform.yml --env-file .env logs platform

# Common: Docker socket not mounted
ls -la /var/run/docker.sock
```

### Tunnel not connecting

```bash
docker compose -f distro/docker-compose.platform.yml --env-file .env logs cloudflared

# Common: credentials missing
ls /etc/cloudflared/credentials.json
```

### Container provisioning fails

```bash
# Check image exists
docker images ghcr.io/hamedmp/matrix-os

# Check port conflicts
sqlite3 /mnt/data/platform/platform.db "SELECT * FROM port_assignments"
```

### User gets 502 Bad Gateway

The shell (port 3000) crashed but the gateway (port 4000) is still running.

```bash
# Check what's listening inside the container
docker exec matrixos-alice netstat -tlnp

# If only port 4000 is listening, shell crashed. Restart the container:
docker restart matrixos-alice

# Check memory usage (shell crash often = OOM)
docker stats matrixos-alice --no-stream
```

### App icons missing or not loading

Icons are generated PNGs stored in `/data/users/{handle}/matrixos/system/icons/`. Common causes:

1. **Icon not generated yet**: Check if the PNG exists on disk. If not, trigger generation:
   ```bash
   curl -X POST https://{handle}.matrix-os.com/api/apps/{slug}/icon
   ```

2. **Module manifest has invalid icon field**: Some `module.json`/`manifest.json` files use emojis or icon names instead of file paths. The shell ignores `meta.icon` and always uses the generated PNG at `/files/system/icons/{slug}.png`. If you see 404s for emoji URLs (e.g. `%F0%9F%94%A5`), the module manifest has `"icon": "emoji"` -- this is harmless, the generated PNG will be used instead.

3. **Cloudflare cached a 404**: If the icon was requested before it was generated, Cloudflare may have cached the 404. Hard refresh (Ctrl+Shift+R) or wait for the CDN cache TTL to expire.

4. **Shell not rebuilt**: Icon-related shell changes require rebuilding the Docker image (`docker build`) and upgrading the container. `docker compose up --build` only rebuilds platform services.

5. **Pinned dock icon stuck on fallback letter**: The `imgFailed` state in DockIcon/AppTile components needs to reset when `iconUrl` changes. If icons show a letter instead of the image after regeneration, this reset logic may be broken.

### API routes return 404 (e.g. /api/layout, /files/...)

The Next.js middleware matcher may be excluding the path. Check `shell/src/proxy.ts` matcher config. Paths ending in `.html`, `.css`, `.js` etc. are excluded by the catch-all pattern but must be explicitly included via dedicated matchers for `/files/`, `/modules/`, etc.

### Stale DB record after manual container deletion

If you `docker rm` a container manually, the platform DB still has its record. The API will fail to destroy/re-provision it.

```bash
# Force-delete via API (handles missing Docker container gracefully)
curl -X DELETE http://localhost:9000/containers/alice \
  -H "Authorization: Bearer $PLATFORM_SECRET"

# Then re-provision
curl -X POST http://localhost:9000/containers/provision \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"handle":"alice","clerkUserId":"user_..."}'
```

### Rolling restart "succeeded" but containers still run old code

Symptoms: `/containers/rolling-restart` reports `succeeded: N / failed: 0`, but the UI still shows the pre-deploy version and `docker inspect matrixos-<handle> --format '{{.Image}}'` returns the old image SHA.

Diagnosis, in order:

1. **Local tag reverted by `docker pull`** (most common):
   ```bash
   docker images ghcr.io/hamedmp/matrix-os --format "{{.ID}} {{.CreatedAt}}"
   ```
   If `CreatedAt` is the old timestamp, the orchestrator's pull overwrote your freshly-built tag with the registry's older image. Fix by switching to `PLATFORM_IMAGE=matrixos-user:local` (see "Deploying a locally-built image" above).

2. **Dangling buildx manifest** (second most common):
   ```bash
   docker images --all --format "{{.Repository}}:{{.Tag}} {{.ID}} {{.CreatedAt}}" \
     | grep -E "(<none>|matrix-os)" | head
   ```
   If there's a `<none>:<none>` entry newer than your tagged image, the build wrote a dangling manifest. Re-tag it manually.

3. **Container has the tag right but is a zombie**:
   ```bash
   docker inspect matrixos-<handle> --format '{{.Image}} {{.Created}}'
   docker inspect <image-ref> --format '{{.Id}} {{.Created}}'
   ```
   The two SHAs should match. If the `Created` timestamp on the container is old, the rolling-restart didn't actually touch it -- check that its handle is present in the rolling-restart response's `results` array (not `skipped`).

### User can't access instance

```bash
docker ps --filter "name=matrixos-alice"
curl -s http://localhost:9000/containers/alice \
  -H "Authorization: Bearer $PLATFORM_SECRET"
docker exec matrixos-alice wget -qO- http://localhost:3000 2>&1 | head -5
docker exec matrixos-alice wget -qO- http://localhost:4000/health 2>&1
```

## Backup

### Quick Backup

```bash
# Platform + proxy DBs
cp /mnt/data/platform/platform.db /backups/platform-$(date +%Y%m%d).db
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

cp /mnt/data/platform/platform.db $BACKUP_DIR/
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

### Hetzner Snapshots

For full-server backups, use Hetzner server snapshots:
```bash
# Via hcloud CLI
hcloud server create-image matrixos-cp-1 --type snapshot --description "v0.3.0 $(date +%Y%m%d)"
```

Or enable automatic backups in Hetzner Console (~20% server cost).
