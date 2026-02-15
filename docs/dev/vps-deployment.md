# VPS Deployment Guide

Complete guide for deploying Matrix OS on a VPS. Covers: building the Docker image, running the platform service, managing user containers, and connecting everything via Cloudflare Tunnel.

## Architecture

```
Internet
  |
  +-- matrix-os.com ---------> Vercel (www/ -- landing, auth, dashboard)
  |
  +-- api.matrix-os.com ----+
  +-- *.matrix-os.com ------+
                            |
                     Cloudflare Tunnel
                            |
                     VPS (no public ports)
                     |
                     +-- cloudflared (tunnel daemon)
                     +-- platform :9000 (orchestrator + subdomain router)
                     +-- proxy :8080 (shared Anthropic API key + cost tracking)
                     +-- matrixos-alice :4001/:3001 (user container)
                     +-- matrixos-bob :4002/:3002 (user container)
                     +-- ...
```

## Prerequisites

- VPS: Ubuntu 22.04+ or Debian 12+, 2GB+ RAM, Docker installed
- Domain: matrix-os.com on Cloudflare (free plan works)
- Accounts: Clerk (auth), Inngest (webhooks), Vercel (www/)
- API key: `ANTHROPIC_API_KEY` for the proxy

## Step 1: VPS Setup

### Install Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Log out and back in
```

### Clone the Repo

```bash
git clone https://github.com/HamedMP/matrix-os.git
cd matrix-os

# Or deploy from a specific tag
git checkout v0.3.0
```

### Build the Matrix OS Image

This is the image used for per-user containers. Build it once on the VPS:

```bash
docker build -t matrix-os:latest -f Dockerfile .
```

This takes a few minutes (installs Node.js, pnpm, builds Next.js shell, installs Claude CLI).

To verify:
```bash
docker images matrix-os
```

### Build Platform Services

The platform and proxy also use the same Dockerfile (they just run different entrypoints):

```bash
docker compose -f distro/docker-compose.platform.yml build
```

## Step 2: Cloudflare Tunnel

The tunnel connects your VPS to Cloudflare's edge without opening any public ports.

### Install cloudflared

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
```

### Create Tunnel

```bash
cloudflared tunnel login          # Opens browser to auth with Cloudflare
cloudflared tunnel create matrix-os

# Note the tunnel ID (e.g., abc12345-def6-7890-...)
# Credentials saved to ~/.cloudflared/<tunnel-id>.json
```

### DNS Records

In Cloudflare Dashboard > DNS:

| Type  | Name | Target                              | Proxy |
|-------|------|-------------------------------------|-------|
| CNAME | api  | `<tunnel-id>.cfargotunnel.com`      | Yes   |
| CNAME | *    | `<tunnel-id>.cfargotunnel.com`      | Yes   |

Root `matrix-os.com` stays pointed at Vercel (separate record).

### Copy Credentials

```bash
sudo mkdir -p /etc/cloudflared
sudo cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/credentials.json
```

The `distro/cloudflared.yml` config routes:
- `api.matrix-os.com` -> `http://localhost:9000` (platform API)
- `*.matrix-os.com` -> `http://localhost:9000` (platform resolves subdomain -> container)

## Step 3: Environment Variables

Create `.env` in the repo root on the VPS:

```bash
cat > .env << 'EOF'
# Required: Anthropic API key for the proxy (shared across all user containers)
ANTHROPIC_API_KEY=sk-ant-...

# Optional: secret for admin API endpoints
PLATFORM_SECRET=your-random-secret-here

# Optional: override container image (defaults to ghcr.io/finnaai/matrix-os:latest)
# Use the locally built image instead:
PLATFORM_IMAGE=matrix-os:latest
EOF
```

## Step 4: Start the Platform

```bash
docker compose -f distro/docker-compose.platform.yml up -d
```

This starts three services:

| Service      | Port | Role |
|-------------|------|------|
| cloudflared | --   | Tunnel daemon, routes Cloudflare traffic to localhost |
| platform    | 9000 | Orchestrator: provisions/manages user containers, subdomain routing |
| proxy       | 8080 | Shared Anthropic API proxy, per-user cost tracking |

### Verify

```bash
# Local health checks
curl http://localhost:9000/health   # {"status":"ok"}
curl http://localhost:8080/health   # {"status":"ok"}

# Via Cloudflare (after DNS propagation, ~1 min)
curl https://api.matrix-os.com/health
```

### View Logs

```bash
# All services
docker compose -f distro/docker-compose.platform.yml logs -f

# Individual service
docker compose -f distro/docker-compose.platform.yml logs platform -f
docker compose -f distro/docker-compose.platform.yml logs proxy -f
docker compose -f distro/docker-compose.platform.yml logs cloudflared -f
```

## Step 5: Vercel + Clerk + Inngest

The `www/` site runs on Vercel. It handles the landing page, auth (Clerk), and dashboard.

### Vercel Environment Variables

Set in Vercel Dashboard > Settings > Environment Variables:

| Variable                           | Value                         |
|-----------------------------------|-----------------------------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_live_...`               |
| `CLERK_SECRET_KEY`                  | `sk_live_...`               |
| `INNGEST_EVENT_KEY`                 | (from Inngest dashboard)    |
| `INNGEST_SIGNING_KEY`               | (from Inngest dashboard)    |
| `PLATFORM_API_URL`                  | `https://api.matrix-os.com` |

### Clerk Configuration

1. Create app at clerk.com
2. Settings > URLs:
   - Sign in: `/login`
   - Sign up: `/signup`
   - After sign in: `/dashboard`
   - After sign up: `/dashboard`
3. Settings > User & Authentication: enable **Username** field (used as Matrix OS handle)
4. Webhooks > Add Endpoint:
   - URL: `https://matrix-os.com/api/inngest`
   - Events: `user.created`, `user.deleted`
   - Use Inngest Transformation Template
5. Admin access: set `publicMetadata.role = "admin"` on your user via Clerk Dashboard > Users

### Inngest Configuration

1. Create app at inngest.com
2. Connect to your Vercel deployment
3. The `/api/inngest` route auto-registers the `provision-matrix-os` function

### User Flow

```
1. User visits matrix-os.com -> landing page
2. Clicks "Get Started" -> Clerk signup (chooses username/handle)
3. Clerk webhook -> Inngest -> POST api.matrix-os.com/containers/provision
4. Platform: allocates ports, creates Docker container, starts it
5. User redirected to dashboard -> clicks "Open Matrix OS"
6. Browser: https://{handle}.matrix-os.com
7. Cloudflare tunnel -> platform -> reverse proxy to container's shell port
8. User sees Matrix OS desktop
```

## Container Management

### Via Dashboard

Visit `https://matrix-os.com/admin` (requires `publicMetadata.role = "admin"` on your Clerk user).

The admin dashboard shows all containers with start/stop/destroy controls.

### Via API

All commands below use the platform API. Replace `api.matrix-os.com` with `localhost:9000` if running locally.

```bash
# List all containers
curl https://api.matrix-os.com/containers

# Get specific container info
curl https://api.matrix-os.com/containers/alice

# Provision manually (bypasses Clerk webhook)
curl -X POST https://api.matrix-os.com/containers/provision \
  -H "content-type: application/json" \
  -d '{"handle":"alice","clerkUserId":"user_123"}'

# Stop a running container (idle save)
curl -X POST https://api.matrix-os.com/containers/alice/stop

# Start a stopped container (wake)
curl -X POST https://api.matrix-os.com/containers/alice/start

# Destroy container (removes Docker container + DB record + releases ports)
curl -X DELETE https://api.matrix-os.com/containers/alice

# Filter by status
curl https://api.matrix-os.com/containers?status=running
curl https://api.matrix-os.com/containers?status=stopped
```

### Via Docker (direct)

```bash
# List user containers
docker ps --filter "name=matrixos-"

# View logs for a specific user
docker logs matrixos-alice -f

# Enter a user's container
docker exec -it matrixos-alice sh

# Inspect resource usage
docker stats --filter "name=matrixos-"
```

### Container Lifecycle

Each user container:
- **Provisions**: Docker container created from `matrix-os:latest`, ports allocated, home volume mounted
- **Running**: shell on `:{shell_port}`, gateway on `:{gateway_port}`, 256MB memory / 0.5 CPU limit
- **Idle timeout**: lifecycle manager checks every 5 min, stops containers idle > 30 min
- **Wake on request**: when a stopped container gets a request via subdomain, platform auto-starts it
- **Destroy**: removes container, releases ports, deletes DB record, volume remains for data recovery

### Port Allocation

Ports are allocated sequentially:
- Gateway ports: 4001, 4002, 4003, ...
- Shell ports: 3001, 3002, 3003, ...

The platform tracks allocations in SQLite. Released ports are recycled.

## Database

The platform uses SQLite (Drizzle ORM). The DB file lives inside the `platform-data` Docker volume.

```bash
# Access the database
docker compose -f distro/docker-compose.platform.yml exec platform sh
sqlite3 /data/platform.db

# Useful queries
SELECT handle, status, port, shell_port, last_active FROM containers;
SELECT * FROM port_assignments;

# Count by status
SELECT status, COUNT(*) FROM containers GROUP BY status;
```

## Updating

### Update Platform (zero-downtime for user containers)

```bash
cd matrix-os
git pull origin main        # or: git checkout v0.4.0
docker compose -f distro/docker-compose.platform.yml build
docker compose -f distro/docker-compose.platform.yml up -d
```

User containers keep running -- they're independent Docker containers. Only the platform/proxy/cloudflared services restart.

### Update User Container Image

```bash
# Build new image
docker build -t matrix-os:latest -f Dockerfile .

# New containers will use the new image
# Existing containers keep their old image until destroyed and re-provisioned
```

To upgrade an existing user: destroy and re-provision (their data volume persists):

```bash
curl -X DELETE https://api.matrix-os.com/containers/alice
curl -X POST https://api.matrix-os.com/containers/provision \
  -H "content-type: application/json" \
  -d '{"handle":"alice","clerkUserId":"user_123"}'
```

### Deploy from a Tag

```bash
git fetch --tags
git checkout v0.3.0
docker build -t matrix-os:v0.3.0 -f Dockerfile .
docker tag matrix-os:v0.3.0 matrix-os:latest
docker compose -f distro/docker-compose.platform.yml up -d --build
```

## Troubleshooting

### Platform won't start

```bash
# Check logs
docker compose -f distro/docker-compose.platform.yml logs platform

# Common: Docker socket not mounted
# Fix: ensure /var/run/docker.sock exists and is accessible
ls -la /var/run/docker.sock
```

### Tunnel not connecting

```bash
docker compose -f distro/docker-compose.platform.yml logs cloudflared

# Common: credentials file missing
# Fix: ensure /etc/cloudflared/credentials.json exists
# and cloudflared-creds volume is populated
```

### Container provisioning fails

```bash
# Check if image exists
docker images matrix-os

# Common: image not built locally
# Fix: docker build -t matrix-os:latest -f Dockerfile .

# Check if ports are available
docker compose -f distro/docker-compose.platform.yml exec platform sh
sqlite3 /data/platform.db "SELECT * FROM port_assignments"
```

### User can't access their instance

```bash
# Check container is running
docker ps --filter "name=matrixos-alice"

# Check platform knows about it
curl http://localhost:9000/containers/alice

# Check shell is responding inside container
docker exec matrixos-alice wget -qO- http://localhost:3000 | head -5
```

## Backup

### Platform Database

```bash
# Copy from Docker volume
docker compose -f distro/docker-compose.platform.yml exec platform \
  cat /data/platform.db > backup-platform.db
```

### User Data

User home directories are in the `user-data` volume at `/data/users/{handle}/matrixos/`.

```bash
# Backup all user data
docker compose -f distro/docker-compose.platform.yml exec platform \
  tar czf /tmp/users-backup.tar.gz /data/users/
docker cp $(docker compose -f distro/docker-compose.platform.yml ps -q platform):/tmp/users-backup.tar.gz .
```

### Full Backup Script

```bash
#!/bin/bash
DATE=$(date +%Y%m%d)
BACKUP_DIR=/backups/matrix-os/$DATE
mkdir -p $BACKUP_DIR

# Platform DB
docker compose -f distro/docker-compose.platform.yml exec -T platform \
  cat /data/platform.db > $BACKUP_DIR/platform.db

# Proxy DB
docker compose -f distro/docker-compose.platform.yml exec -T proxy \
  cat /data/proxy.db > $BACKUP_DIR/proxy.db

# User data
docker compose -f distro/docker-compose.platform.yml exec -T platform \
  tar czf - /data/users/ > $BACKUP_DIR/users.tar.gz

echo "Backup complete: $BACKUP_DIR"
```
