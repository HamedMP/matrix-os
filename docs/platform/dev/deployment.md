# Platform Deployment Guide

This document is the short control-plane deployment guide. The full operator runbook is [VPS Deployment Guide](../../dev/vps-deployment.md).

## Current Production Shape

Production Matrix OS is VPS-native:

- one platform/control-plane VPS;
- one customer VPS per active user;
- Matrix gateway, shell, code-server, sync, and app assets run on the customer VPS through host services;
- each customer VPS has its own local Postgres endpoint at `127.0.0.1:5432`;
- customer VPSes download the published host bundle from `system-bundles/<CUSTOMER_VPS_IMAGE_VERSION>/`;
- Pipedream, Clerk server-side auth, provisioning, routing, and host-bundle publication stay on the platform.

Legacy Docker Compose and `/containers/*` instructions are not the production customer runtime. They are only for archived shared-container deployments or local development.

## Prerequisites

- Hetzner account and customer project quota.
- Cloudflare account with `matrix-os.com`.
- Clerk account for auth.
- Inngest/Vercel setup for signup flows where used.
- Cloudflare R2 bucket for host bundles, DB snapshots, and system metadata.
- A platform Postgres database configured by `PLATFORM_DATABASE_URL` or `POSTGRES_URL`.

## Cloudflare Routing

Root `matrix-os.com` stays on Vercel. The Matrix OS runtime domains point at the platform tunnel:

| Type | Name | Target |
|------|------|--------|
| CNAME | api | `<tunnel-id>.cfargotunnel.com` |
| CNAME | app | `<tunnel-id>.cfargotunnel.com` |
| CNAME | code | `<tunnel-id>.cfargotunnel.com` |
| CNAME | * | `<tunnel-id>.cfargotunnel.com` |

`app.matrix-os.com` and `code.matrix-os.com` are session-based. `{handle}.matrix-os.com` is handle-based. In all cases, the platform resolves the user or handle to a `running` `user_machines` row before proxying to the customer VPS.

## Required Platform Environment

Minimum platform/control-plane env:

```bash
PLATFORM_DATABASE_URL=postgresql://...
PLATFORM_SECRET=...
PLATFORM_PUBLIC_URL=https://app.matrix-os.com
CLERK_SECRET_KEY=sk_live_or_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_or_test_...
PLATFORM_JWT_SECRET=...

CUSTOMER_VPS_ENABLED=true
CUSTOMER_VPS_IMAGE_VERSION=matrix-os-host-dev
HETZNER_API_TOKEN=...
HETZNER_CUSTOMER_PROJECT=matrix-os-customers
HETZNER_LOCATION=nbg1
HETZNER_SERVER_TYPE=cpx22
HETZNER_SSH_KEY_NAME=matrix-ops

R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=matrixos-sync
```

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` is required at host-bundle build time because it is baked into the Next.js shell bundle.

Platform-owned integrations also need:

```bash
PIPEDREAM_CLIENT_ID=...
PIPEDREAM_CLIENT_SECRET=...
PIPEDREAM_PROJECT_ID=...
PIPEDREAM_WEBHOOK_SECRET=...
```

Do not copy `PIPEDREAM_*`, Clerk server secrets, platform DB credentials, or `PLATFORM_SECRET` into customer VPS env files. Customer VPS gateways call the platform through `PLATFORM_INTERNAL_URL` with a per-host `UPGRADE_TOKEN`.

## Host Bundle

Build and publish the customer VPS host bundle before provisioning or refreshing customer VPSes:

```bash
set -a
source .env
set +a
./scripts/build-host-bundle.sh
sha256sum dist/host-bundle/matrix-host-bundle.tar.gz
```

Publish:

```text
system-bundles/$CUSTOMER_VPS_IMAGE_VERSION/matrix-host-bundle.tar.gz
system-bundles/$CUSTOMER_VPS_IMAGE_VERSION/matrix-host-bundle.tar.gz.sha256
```

The bundle contains `/opt/matrix/app`, `/opt/matrix/runtime`, and `/opt/matrix/bin`. It includes bundled Vite/React default apps and the launchers for `matrix-gateway.service`, `matrix-shell.service`, `matrix-code.service`, `matrix-sync-agent.service`, and `matrix-update`.

## Customer VPS Provisioning

Manual smoke provision:

```bash
curl -sS -X POST "$PLATFORM_PUBLIC_URL/vps/provision" \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"clerkUserId":"user_test_vps","handle":"vps-test"}'
```

Expected flow:

1. Platform inserts or returns a `user_machines` row.
2. Platform renders cloud-init with machine env, R2 env, local Postgres password, host-bundle URL, and registration token.
3. Hetzner creates the customer VPS.
4. Cloud-init downloads and verifies the host bundle.
5. The customer VPS starts local Postgres, restores any R2 DB snapshot, starts Matrix services, and calls `/vps/register`.
6. Platform marks the machine `running`.

Status:

```bash
curl -sS "$PLATFORM_PUBLIC_URL/vps/$MACHINE_ID/status" \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

## Verification

Platform:

```bash
curl http://localhost:9000/health
psql "$PLATFORM_DATABASE_URL" -c "SELECT handle, status, public_ipv4, image_version, last_seen_at FROM user_machines ORDER BY created_at DESC LIMIT 20"
```

Customer VPS:

```bash
ssh matrix@<customer-vps-ip> 'systemctl status matrix-gateway.service matrix-shell.service matrix-code.service --no-pager'
ssh matrix@<customer-vps-ip> 'journalctl -u matrix-gateway.service -u matrix-shell.service -n 200 --no-pager'
ssh matrix@<customer-vps-ip> 'grep -E "^(PLATFORM_INTERNAL_URL|UPGRADE_TOKEN|MATRIX_HANDLE|DATABASE_URL)=" /opt/matrix/env/host.env'
ssh matrix@<customer-vps-ip> 'pg_isready --host=127.0.0.1 --username=matrix --dbname=matrix'
```

App data verification:

```bash
ssh matrix@<customer-vps-ip> \
  'curl -fsS http://127.0.0.1:4000/api/bridge/query \
    -H "Content-Type: application/json" \
    -d "{\"action\":\"listApps\",\"app\":\"_\"}"'
```
