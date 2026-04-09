# 049 Integrations -- VPS Deployment Guide

Deploys the Pipedream Connect integration layer to the production VPS. The platform DB auto-migrates on gateway startup -- no manual SQL needed for fresh deploys.

## Prerequisites

- VPS running with `distro/docker-compose.platform.yml`
- Postgres service healthy on `matrixos-net`
- Pipedream Connect project created at pipedream.com/connect

## 1. Get Pipedream Credentials

From your Pipedream Connect project settings:

```
PIPEDREAM_CLIENT_ID=oi_xxxxxxxx
PIPEDREAM_CLIENT_SECRET=sk_xxxxxxxx
PIPEDREAM_PROJECT_ID=proj_xxxxxxxx
PIPEDREAM_ENVIRONMENT=development     # or "production" on paid plan
PIPEDREAM_WEBHOOK_SECRET=whsec_xxxxx  # from project > webhooks
```

## 2. Create the Platform Integration Database

Each user container gets its own Postgres database (`matrixos_{handle}`) for app data via `DATABASE_URL`. The integrations layer needs a separate shared database for cross-user platform state (connected services, billing, etc.).

Create it on the VPS Postgres instance:

```bash
# SSH into VPS
ssh root@49.13.126.159

# Create the platform integrations database
docker exec -i $(docker ps -qf name=postgres) psql -U matrixos -d matrixos -c "
  CREATE DATABASE matrixos_platform;
"
```

The gateway auto-migrates on startup -- it creates all 5 tables (`users`, `connected_services`, `user_apps`, `event_subscriptions`, `billing`) and indexes including `UNIQUE(user_id, pipedream_account_id)`.

## 3. Add Environment Variables

Add to the platform `.env` file on the VPS (or wherever `docker-compose.platform.yml` reads env from):

```env
# Pipedream Connect
PIPEDREAM_CLIENT_ID=oi_xxxxxxxx
PIPEDREAM_CLIENT_SECRET=sk_xxxxxxxx
PIPEDREAM_PROJECT_ID=proj_xxxxxxxx
PIPEDREAM_ENVIRONMENT=development
PIPEDREAM_WEBHOOK_SECRET=whsec_xxxxx
```

These need to reach user containers. The orchestrator passes them via `extraEnv` in `buildEnv()`.

## 4. Wire Pipedream Env Into User Containers

The platform orchestrator (`packages/platform/src/main.ts`) builds `extraEnv` and passes it to each user container. Add the Pipedream vars:

In `packages/platform/src/main.ts`, find the `extraEnv` block (~line 599) and add:

```typescript
const extraEnv: string[] = [];
// existing
if (process.env.CLERK_SECRET_KEY) {
  extraEnv.push(`CLERK_SECRET_KEY=${process.env.CLERK_SECRET_KEY}`);
}
if (process.env.GEMINI_API_KEY) {
  extraEnv.push(`GEMINI_API_KEY=${process.env.GEMINI_API_KEY}`);
}
// NEW: Pipedream Connect credentials for integrations
for (const key of [
  'PIPEDREAM_CLIENT_ID',
  'PIPEDREAM_CLIENT_SECRET',
  'PIPEDREAM_PROJECT_ID',
  'PIPEDREAM_ENVIRONMENT',
  'PIPEDREAM_WEBHOOK_SECRET',
]) {
  if (process.env[key]) extraEnv.push(`${key}=${process.env[key]}`);
}
```

Also add `PLATFORM_DATABASE_URL` in the `buildEnv()` function (`packages/platform/src/orchestrator.ts` ~line 134):

```typescript
// After the DATABASE_URL push
if (postgresUrl) {
  env.push(`PLATFORM_DATABASE_URL=${postgresUrl}/matrixos_platform`);
}
```

## 5. Add Pipedream Vars to docker-compose.platform.yml

Add the env vars to the `platform` service so the orchestrator process can read them:

```yaml
platform:
  environment:
    # ... existing vars ...
    - PIPEDREAM_CLIENT_ID=${PIPEDREAM_CLIENT_ID}
    - PIPEDREAM_CLIENT_SECRET=${PIPEDREAM_CLIENT_SECRET}
    - PIPEDREAM_PROJECT_ID=${PIPEDREAM_PROJECT_ID}
    - PIPEDREAM_ENVIRONMENT=${PIPEDREAM_ENVIRONMENT:-development}
    - PIPEDREAM_WEBHOOK_SECRET=${PIPEDREAM_WEBHOOK_SECRET}
```

## 6. Configure Pipedream Webhook

In your Pipedream Connect project settings, set the webhook URL to:

```
https://api.matrix-os.com/api/integrations/webhook/connected
```

This endpoint uses HMAC signature verification (`x-pd-signature` header) and is excluded from bearer token auth.

## 7. Deploy

```bash
# On VPS
cd /path/to/matrix-os

# Pull latest code
git pull origin main

# Rebuild the image
docker compose -f distro/docker-compose.platform.yml build

# Restart platform (picks up new env vars, orchestrator changes)
docker compose -f distro/docker-compose.platform.yml up -d platform

# Rolling restart all user containers (picks up new env vars)
# Via platform API:
curl -X POST http://localhost:9000/admin/rolling-restart \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

## 8. Verify

```bash
# Check gateway picked up integrations
docker logs matrixos-{handle} 2>&1 | grep integrations

# Expected output:
# [platform-db] Initialized
# [platform-db] Integration routes ready
# [platform-db] Integration routes mounted (after auth)
# [integrations] Component keys discovered: X/Y matched, Z errors

# Test the available services endpoint
curl -s http://localhost:4001/api/integrations/available | jq '.[].name'
# Expected: "Gmail", "Google Calendar", "Google Drive", "GitHub", "Slack", "Discord"
```

## How It Works at Runtime

```
User clicks "Connect Gmail" in Settings
  -> Shell POST /api/integrations/connect { service: "gmail" }
  -> Gateway resolves user from x-platform-user-id (Clerk ID)
  -> Creates Pipedream Connect token, returns OAuth URL
  -> User authorizes in browser popup
  -> Pipedream calls POST /api/integrations/webhook/connected (HMAC verified)
  -> Gateway stores connection in matrixos_platform.connected_services
  -> WebSocket broadcasts integration:connected to shell

User says "list my unread emails"
  -> Kernel calls call_service IPC tool
  -> Gateway POST /api/integrations/call { service: "gmail", action: "list_messages" }
  -> Looks up user's Gmail connection in platform DB
  -> If componentKey discovered: sdk.actions.run() (Actions API)
  -> If no componentKey: sdk.proxy.post() (fallback proxy)
  -> Returns data to kernel, kernel summarizes for user
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Integration routes mounted" not in logs | Missing `PIPEDREAM_CLIENT_ID` or `PLATFORM_DATABASE_URL` | Check env vars reach the container |
| "Actions API requires paid plan" warning | Free Pipedream plan | Upgrade at pipedream.com/pricing, or ignore (proxy fallback works) |
| Webhook returns 401 | Wrong `PIPEDREAM_WEBHOOK_SECRET` | Verify secret matches Pipedream project settings |
| User gets 401 on all integration endpoints | Auth middleware blocking | Verify `x-platform-user-id` header is forwarded by platform proxy |
| "User not found" after platform auth | Clerk ID not in platform DB | User needs to be provisioned first (handled by orchestrator) |
| Duplicate connections after webhook retry | Missing unique constraint | Run: `CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_services_user_account ON connected_services(user_id, pipedream_account_id)` |

## Database Schema (auto-created)

```sql
-- Core tables (auto-migrated by gateway on startup)
users                  -- platform users (clerk_id, handle, pipedream_external_id)
connected_services     -- OAuth connections (UNIQUE user_id + pipedream_account_id)
user_apps              -- apps that use integrations (UNIQUE user_id + slug)
event_subscriptions    -- future: streaming event subscriptions
billing                -- future: usage tracking
```
