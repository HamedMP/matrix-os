---
name: matrix-integrations
description: Use Matrix OS platform-owned integrations from apps or agents without exposing provider secrets on customer VPSes or inside Hermes.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Matrix OS, integrations, Pipedream, OAuth, platform]
    related_skills: [matrix-app-builder]
    config:
      - key: matrix.gateway_url
        description: Matrix gateway URL reachable from the Hermes runtime.
        default: "http://localhost:4000"
        prompt: Matrix gateway URL
---

# Matrix Integrations

## When to Use

Use this when the user wants Gmail, Calendar, Drive, GitHub, Linear, Slack, Discord, or other external services inside Matrix.

## Security Model

- Platform owns Pipedream credentials and OAuth app secrets.
- Customer VPSes should not store provider secrets.
- Hermes should not store provider secrets or `PIPEDREAM_*` OAuth client credentials.
- Apps call Matrix integration endpoints through Matrix auth.
- Provider names and raw upstream errors should not be exposed as client-facing error details.

## Agent Flow

1. Discover available services/actions when the user asks what can be connected.
2. Check connected services.
3. If missing, start OAuth through Matrix.
4. After the user finishes OAuth, sync services.
5. Call the service action through Matrix.
6. Store resulting app data in Matrix/Postgres if needed.

## Gateway API

Default base URL inside a Matrix user instance:

```text
http://localhost:4000
```

Use the configured `skills.config.matrix.gateway_url` if Hermes injects one.

### List Available Services and Actions

```bash
curl -fsS "$MATRIX_GATEWAY_URL/api/integrations/available"
```

Use this for app-building decisions and to avoid hardcoding stale service/action lists.

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

Inside a Matrix app iframe, prefer relative URLs with timeouts:

```ts
async function listServices() {
  const res = await fetch("/api/bridge/service", {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Could not load connected services");
  return res.json();
}

async function callService(service: string, action: string, params: unknown) {
  const res = await fetch("/api/bridge/service", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ service, action, params }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error("Service request failed");
  return res.json();
}
```

## Common Actions

- Gmail: `list_messages`, `get_message`, `send_email`, `search`, `list_labels`
- Google Calendar: `list_events`, `create_event`, `update_event`, `delete_event`
- Google Drive: `list_files`, `get_file`, `upload_file`, `share_file`
- GitHub: `list_repos`, `list_issues`, `create_issue`, `list_prs`, `get_notifications`
- Linear: `viewer`, `list_teams`, `list_projects`, `list_workflow_states`, `list_issues`, `create_issue`, `update_issue`, `add_comment`, `create_workflow_state`, `graphql`
- Slack: `send_message`, `list_channels`, `list_messages`, `search`, `react`
- Discord: `send_message`, `list_servers`, `list_channels`, `list_messages`

## Hooks and Webhooks

Pipedream Connect has two webhook categories:

- Connection webhooks: Matrix OS handles OAuth success/failure through `/api/integrations/webhook/connected`. In local dev or private networks, run the sync endpoint after the user authorizes because Pipedream may not be able to reach the gateway.
- Trigger webhooks: Pipedream can deliver events from deployed triggers to a configured webhook URL. Treat this as backend/platform wiring. Do not put Pipedream signing keys, OAuth clients, or provider tokens in app source, `matrix.json`, Hermes config, Claude Code config, or Codex config.

For event-driven Matrix apps, receive trigger webhooks in a Matrix-owned backend route, validate the Pipedream signature with constant-time comparison, normalize/store event data in Matrix/Postgres, and let the app read it through Matrix APIs. If no such route exists for the event source, the app can use connected-account actions now but needs backend integration work before it can receive new external events.

## Hermes MCP Notes

Hermes supports HTTP and stdio MCP servers, but do not configure Pipedream's remote MCP server on a customer VPS with platform-owned Pipedream secrets. Use Matrix gateway APIs as the credential boundary. A future Matrix-owned MCP broker may expose Pipedream MCP tools safely, but the current safe path is through `/api/integrations*` and `/api/bridge/service`.

## Pitfalls

- Do not ask for provider API keys in chat.
- Do not put OAuth tokens in `matrix.json`, app source, or Hermes config.
- Do not configure Pipedream remote MCP directly in Hermes with Matrix platform credentials.
- Do not call provider APIs directly from app code unless the provider is public and unauthenticated.
- After OAuth, always sync before saying the connection failed.
- If a customer VPS lacks Pipedream env vars, that is expected. The gateway should proxy integration calls to platform.

## Verification

- `GET /api/integrations` returns services or an empty list, not a 404.
- OAuth connect returns a URL.
- Sync works after the user authorizes.
- App code uses `/api/bridge/service` or Matrix integration APIs, not raw provider secrets.
