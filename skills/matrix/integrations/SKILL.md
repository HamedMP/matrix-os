---
name: matrix-integrations
description: Use Matrix OS platform-owned integrations from apps or agents without exposing provider secrets on customer VPSes or inside Agent.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  agent:
    tags: [Matrix OS, integrations, Pipedream, OAuth, platform]
    related_skills: [matrix-app-builder]
    config:
      - key: matrix.gateway_url
        description: Matrix gateway URL reachable from the Agent runtime.
        default: "http://localhost:4000"
        prompt: Matrix gateway URL
---

# Matrix Integrations

## When to Use

Use this when the user wants Gmail, Calendar, Drive, GitHub, Slack, Discord, or other external services inside Matrix.

## Security Model

- Platform owns Pipedream credentials and OAuth app secrets.
- Customer VPSes should not store provider secrets.
- Agent should not store provider secrets.
- Apps call Matrix integration endpoints through Matrix auth.
- Provider names and raw upstream errors should not be exposed as client-facing error details.

## Agent Flow

1. Check connected services.
2. If missing, start OAuth through Matrix.
3. After the user finishes OAuth, sync services.
4. Call the service action through Matrix.
5. Store resulting app data in Matrix/Postgres if needed.

## Gateway API

Default base URL inside a Matrix user instance:

```text
http://localhost:4000
```

Use the configured `skills.config.matrix.gateway_url` if Agent injects one.

### List Connected Services

```bash
curl -fsS "$MATRIX_GATEWAY_URL/api/integrations"
```

### Start OAuth

```bash
curl -fsS "$MATRIX_GATEWAY_URL/api/integrations/connect" \
  -H 'Content-Type: application/json' \
  -d '{"service":"github","label":"Work GitHub"}'
```

Return the connect URL to the user. Do not immediately claim success.

### Sync After OAuth

```bash
curl -fsS "$MATRIX_GATEWAY_URL/api/integrations/sync" \
  -X POST \
  -H 'Content-Type: application/json' \
  -d '{}'
```

### Call an Action

```bash
curl -fsS "$MATRIX_GATEWAY_URL/api/integrations/call" \
  -H 'Content-Type: application/json' \
  -d '{"service":"github","action":"list_repos","params":{"sort":"updated","per_page":10}}'
```

## In-App Bridge

Inside a Matrix app iframe, use the injected `window.MatrixOS` bridge. Apps run as sandboxed
`srcdoc` iframes; direct `fetch()` calls to `/api/bridge/*` are blocked by the shell CORS/CSP
boundary.

```ts
async function listServices() {
  if (!window.MatrixOS?.integrations) throw new Error("Matrix integrations bridge is unavailable");
  return window.MatrixOS.integrations();
}

async function callService(service: string, action: string, params: unknown) {
  if (!window.MatrixOS?.service) throw new Error("Matrix service bridge is unavailable");
  return window.MatrixOS.service(service, action, params);
}
```

## Common Actions

- Gmail: `list_messages`, `get_message`, `send_email`, `search`, `list_labels`
- Google Calendar: `list_events`, `create_event`, `update_event`, `delete_event`
- Google Drive: `list_files`, `get_file`, `upload_file`, `share_file`
- GitHub: `list_repos`, `list_issues`, `create_issue`, `list_prs`, `get_notifications`
- Slack: `send_message`, `list_channels`, `list_messages`, `search`, `react`
- Discord: `send_message`, `list_servers`, `list_channels`, `list_messages`

## Pitfalls

- Do not ask for provider API keys in chat.
- Do not put OAuth tokens in `matrix.json`, app source, or Agent config.
- Do not call provider APIs directly from app code unless the provider is public and unauthenticated.
- After OAuth, always sync before saying the connection failed.
- If a customer VPS lacks Pipedream env vars, that is expected. The gateway should proxy integration calls to platform.

## Verification

- `GET /api/integrations` returns services or an empty list, not a 404.
- OAuth connect returns a URL.
- Sync works after the user authorizes.
- App code uses `window.MatrixOS.integrations()` / `window.MatrixOS.service()`, not raw provider secrets or direct `/api/bridge/*` fetches.
