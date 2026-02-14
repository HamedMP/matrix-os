# Platform Deployment Guide

## Prerequisites

- VPS with Docker installed (Ubuntu 22.04+ recommended)
- Cloudflare account with domain (matrix-os.com)
- Clerk account (for auth)
- Inngest account (for webhook processing)
- Vercel account (for www/ deployment)

## 1. Cloudflare Setup

### Create Tunnel

```bash
# Install cloudflared on VPS
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Authenticate
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create matrix-os

# Note the tunnel ID (e.g., abc123-def456-...)
```

### DNS Records

In Cloudflare dashboard, add CNAME records:

| Type | Name | Target |
|------|------|--------|
| CNAME | api | `<tunnel-id>.cfargotunnel.com` |
| CNAME | * | `<tunnel-id>.cfargotunnel.com` |

The root `matrix-os.com` is handled by Vercel (separate DNS record).

### Tunnel Credentials

Copy the credentials file to the VPS:
```bash
# Created during `cloudflared tunnel create`
# Usually at ~/.cloudflared/<tunnel-id>.json
cp ~/.cloudflared/<tunnel-id>.json /etc/cloudflared/credentials.json
```

## 2. Platform Deployment

### Environment Variables

Create `.env` on the VPS:

```bash
ANTHROPIC_API_KEY=sk-ant-...
PLATFORM_SECRET=<random-secret-for-admin-api>
```

### Start Services

```bash
git clone https://github.com/FinnaAI/matrix-os.git
cd matrix-os

docker compose -f distro/docker-compose.platform.yml up -d
```

This starts:
- **cloudflared** -- tunnel daemon, routes traffic from Cloudflare
- **platform** -- orchestrator on :9000, manages user containers
- **proxy** -- shared API proxy on :8080, tracks usage

### Verify

```bash
# Health checks
curl http://localhost:9000/health
curl http://localhost:8080/health

# From outside (via Cloudflare)
curl https://api.matrix-os.com/health
```

## 3. Vercel (www/) Setup

### Environment Variables

Set in Vercel dashboard:

| Variable | Value |
|----------|-------|
| NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY | pk_live_... |
| CLERK_SECRET_KEY | sk_live_... |
| INNGEST_EVENT_KEY | (from Inngest dashboard) |
| INNGEST_SIGNING_KEY | (from Inngest dashboard) |
| PLATFORM_API_URL | https://api.matrix-os.com |

### Clerk Configuration

1. Create Clerk application at clerk.com
2. Set sign-in/sign-up URLs:
   - Sign in: /login
   - Sign up: /signup
   - After sign in: /dashboard
   - After sign up: /dashboard
3. Enable username field (used as Matrix OS handle)
4. Configure webhook:
   - In Clerk Dashboard -> Webhooks -> Add Endpoint
   - URL: `https://matrix-os.com/api/inngest`
   - Events: `user.created`, `user.deleted`
   - Use Inngest Transformation Template

### Inngest Configuration

1. Create Inngest app at inngest.com
2. Connect to Vercel deployment
3. The `/api/inngest` route auto-registers the `provision-matrix-os` function

## 4. Manual Container Management

```bash
# Provision a container manually
curl -X POST https://api.matrix-os.com/containers/provision \
  -H "content-type: application/json" \
  -d '{"handle":"alice","clerkUserId":"user_123"}'

# Check status
curl https://api.matrix-os.com/containers/alice

# Stop
curl -X POST https://api.matrix-os.com/containers/alice/stop

# Start
curl -X POST https://api.matrix-os.com/containers/alice/start

# Destroy
curl -X DELETE https://api.matrix-os.com/containers/alice

# List all
curl https://api.matrix-os.com/containers
```

## 5. Monitoring

### Container Logs

```bash
# Platform service logs
docker compose -f distro/docker-compose.platform.yml logs platform -f

# User container logs
docker logs matrixos-alice -f

# Cloudflare tunnel logs
docker compose -f distro/docker-compose.platform.yml logs cloudflared -f
```

### Database

The platform SQLite database lives at `/data/platform.db` inside the platform container (mapped to the `platform-data` volume).

```bash
# Enter platform container
docker compose -f distro/docker-compose.platform.yml exec platform sh

# Query DB
sqlite3 /data/platform.db "SELECT handle, status, last_active FROM containers"
```
