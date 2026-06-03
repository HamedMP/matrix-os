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

`app.matrix-os.com` and `code.matrix-os.com` are session-based. The platform resolves the signed-in Clerk user to a `running` `user_machines` row before proxying to the customer VPS. Do not document or depend on per-user Matrix subdomains for the managed product.

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

## Updating Platform Auth and Device-Login Pages

`app.matrix-os.com` sign-in, sign-up, billing handoff, provisioning handoff, and
CLI device-login pages are served by the platform Docker service. Pulling
`main` on the platform VPS is not enough: the running `distro-platform-1`
container keeps serving the previously built image until the platform service is
rebuilt and recreated.

Rebuild the platform Docker service whenever a PR changes:

- `packages/platform/src/auth-routes.ts`
- `packages/platform/src/main.ts` auth, sign-in, sign-up, billing, or provisioning routes
- Clerk redirect/sign-in/sign-up environment wiring
- `distro/docker-compose.platform.yml` for `platform` or `auth-shell`
- platform pages that users reach at `app.matrix-os.com`

On the platform VPS, keep the main checkout clean and deploy from a manual
worktree pointed at `origin/main`:

```bash
git fetch origin main
DEPLOY_SHA="$(git rev-parse --short origin/main)"
git worktree add --detach "/home/deploy/matrix-os.worktrees/platform-main-$DEPLOY_SHA" origin/main
cd "/home/deploy/matrix-os.worktrees/platform-main-$DEPLOY_SHA/distro"
docker compose -p distro \
  --env-file /home/deploy/matrix-os/.env \
  -f docker-compose.platform.yml \
  up -d --build platform
cd /home/deploy/matrix-os
git worktree remove --force "/home/deploy/matrix-os.worktrees/platform-main-$DEPLOY_SHA"
git worktree prune
```

The existing production Compose project is named `distro`; keep `-p distro` so
Compose replaces `distro-platform-1` and does not create a second stack. The
command may also rebuild and restart `distro-auth-shell-1` because it shares the
same image build graph. Remove the temporary deploy worktree after the Compose
command succeeds so old monorepo copies do not accumulate on the platform VPS.

After the rebuild, verify the platform page actually changed:

```bash
curl -sS https://app.matrix-os.com/health
curl -sS -X POST https://app.matrix-os.com/api/auth/device/code \
  -H 'Content-Type: application/json' \
  -d '{"clientId":"matrixos-cli"}'

# Use the returned verificationUri. For current CLI device signup, the
# server-rendered inline HTML must contain both Clerk sign-up and sign-in
# handoff URLs back to /auth/device. These strings are not emitted by a bundled
# client build, so they are stable smoke-test anchors for this platform route.
curl -sS 'https://app.matrix-os.com/auth/device?user_code=<code>' \
  | rg "mountSignUp|signInUrl: deviceAuthUrl|signUpUrl: deviceAuthUrl"
```

If the final check has no output, `app.matrix-os.com` is still serving an old
platform image, the request is not reaching the platform container expected by
the current Compose project, or the device-auth route changed and this smoke
check needs to be updated alongside it.

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
