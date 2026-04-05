# Spec 049: Platform Integrations

**Created**: 2026-03-16
**Updated**: 2026-04-05
**Status**: Draft (v2)

## Overview

Matrix OS is a platform where every user has a computer in the cloud. To make those computers useful, users need to connect their existing tools -- Gmail, Calendar, Drive, GitHub, Slack, Discord -- so their AI coding agent can read, write, and build apps on top of real data.

This spec covers three things:

1. **Platform database** -- centralized Postgres for managing users, connections, service registry, and billing foundations across the entire Matrix OS platform
2. **Pipedream Connect integration** -- OAuth, credential management, and API proxy for 3,000+ services
3. **Shell settings UI** -- click-to-connect integration management alongside the existing conversational flow

Users connect services through settings UI or conversation. The AI agent calls connected APIs via the gateway. When users want apps built ("summarize my emails every morning"), the agent writes code that uses the same integration APIs.

## Architecture

### Platform Database (Postgres + Kysely)

A centralized Postgres instance (separate from per-user Postgres in spec 050) that gives Matrix OS platform-level visibility into all users and their activity.

```
Platform Postgres (shared, managed by gateway)
│
├── users
│   ├── id (uuid, PK)
│   ├── clerk_id (text, unique)           -- Clerk auth provider
│   ├── handle (text, unique)             -- @user:matrix-os.com
│   ├── display_name (text)
│   ├── email (text)
│   ├── container_id (text, unique)       -- Docker container mapping
│   ├── container_version (text)          -- which Matrix OS version
│   ├── plan (text, default 'free')       -- free/pro/enterprise
│   ├── status (text, default 'active')   -- active/suspended/deleted
│   ├── pipedream_external_id (text)      -- maps to Pipedream external_user_id
│   ├── created_at (timestamptz)
│   └── updated_at (timestamptz)
│
├── connected_services
│   ├── id (uuid, PK)
│   ├── user_id (uuid, FK → users)
│   ├── service (text)                    -- 'gmail', 'github', 'slack'
│   ├── pipedream_account_id (text)       -- Pipedream credential reference
│   ├── account_label (text)              -- "Work Gmail", "Personal Gmail"
│   ├── account_email (text, nullable)    -- which account was authed
│   ├── scopes (text[])                   -- permissions granted
│   ├── status (text, default 'active')   -- active/expired/revoked
│   ├── connected_at (timestamptz)
│   └── last_used_at (timestamptz)
│
├── user_apps (local workspace apps authored by this user -- NOT gallery listings)
│   ├── id (uuid, PK)
│   ├── user_id (uuid, FK → users)
│   ├── name (text)
│   ├── slug (text)                       -- unique per user
│   ├── description (text, nullable)
│   ├── services_used (text[])            -- ['gmail', 'slack'] or []
│   ├── created_at (timestamptz)
│   └── updated_at (timestamptz)
│
├── event_subscriptions (future: streaming)
│   ├── id (uuid, PK)
│   ├── user_id (uuid, FK → users)
│   ├── service (text)
│   ├── event_type (text)                 -- 'email.received', 'pr.opened'
│   ├── status (text, default 'active')
│   └── created_at (timestamptz)
│
└── billing
    ├── id (uuid, PK)
    ├── user_id (uuid, FK → users)
    ├── stripe_customer_id (text, nullable)
    ├── plan (text)
    ├── connected_services_count (integer)
    ├── period_start (timestamptz)
    ├── period_end (timestamptz)
    └── status (text)                     -- active/past_due/cancelled
```

Credentials never touch this database. Pipedream stores encrypted OAuth tokens. We only store a `pipedream_account_id` reference. Even if the platform DB is compromised, no user tokens are exposed.

### Integration Flow

**Connecting a service (OAuth):**

```
User clicks [Connect Gmail] in settings    User says "connect my Gmail"
         │                                          │
         └──────────────┬───────────────────────────┘
                        ▼
              POST /api/integrations/connect
              { service: "gmail", label?: "Work" }
                        │
                        ▼
               ┌─────────────────┐
               │    Gateway      │
               │                 │
               │ 1. Get/create   │
               │    Pipedream    │
               │    Connect token│
               │ 2. Return OAuth │
               │    URL          │
               └────────┬────────┘
                        │
                        ▼
              User authorizes in browser
              (Google/GitHub/Slack consent screen)
                        │
                        ▼
              Pipedream stores tokens,
              fires connection webhook
                        │
                        ▼
               ┌─────────────────┐
               │    Gateway      │
               │                 │
               │ 1. Write to     │
               │    platform DB  │
               │    (connected_  │
               │    services)    │
               │ 2. Push update  │
               │    to shell via │
               │    WebSocket    │
               │ 3. Notify       │
               │    container    │
               │    via IPC      │
               └─────────────────┘
```

**Using a service (API call via Pipedream Actions):**

```
Agent: call_service("gmail", "list_messages", { query: "is:unread" })
  │
  ▼
Gateway ──▶ Pipedream Actions API ──▶ Gmail API
  │         (client.actions.run)        │
  ◀────────────── response ────────────┘
  │
  ▼
Agent receives unread emails
```

The gateway translates our action names (e.g., `list_messages`) to Pipedream component keys (e.g., `gmail-list-messages`) and calls `client.actions.run()` with the user's connected account (`authProvisionId`). Pipedream handles the actual API call, auth injection, and response formatting.

### Gateway API

Same endpoints serve both the shell settings UI and the agent's IPC tools:

```
POST   /api/integrations/connect          -- initiate OAuth flow
GET    /api/integrations                  -- list user's connections
DELETE /api/integrations/:id              -- disconnect a service
GET    /api/integrations/available        -- service registry (what can be connected)
POST   /api/integrations/call             -- authenticated API call (agent uses this)
GET    /api/integrations/:id/status       -- check connection health
POST   /api/integrations/:id/refresh      -- force token refresh
```

**Auth Matrix:**

| Endpoint | Auth Method | Public? |
|----------|-------------|---------|
| `GET /api/integrations/available` | None (public catalog) | Yes |
| `GET /api/integrations` | Clerk session or IPC token | No |
| `POST /api/integrations/connect` | Clerk session or IPC token | No |
| `POST /api/integrations/webhook/connected` | Pipedream webhook signature (HMAC) | Yes (webhook) |
| `POST /api/integrations/call` | Clerk session or IPC token | No |
| `GET /api/integrations/:id/status` | Clerk session or IPC token | No |
| `DELETE /api/integrations/:id` | Clerk session or IPC token | No |
| `POST /api/integrations/:id/refresh` | Clerk session or IPC token | No |

The gateway maps the authenticated user to their `pipedream_external_id` for all Pipedream SDK calls. The webhook endpoint uses HMAC signature verification (Pipedream signs payloads with a shared secret) instead of session auth.

### IPC Tools (Agent-Facing)

Two tools registered on the kernel's MCP server:

**`connect_service`**
```typescript
{
  service: string,      // 'gmail', 'github', 'slack', etc.
  label?: string        // 'Work Gmail', 'Personal'
}
// Returns: { url: string, service: string }
// The agent presents the URL to the user
```

**`call_service`**
```typescript
{
  service: string,      // 'gmail'
  action: string,       // 'list_messages'
  params?: object,      // { query: "is:unread", maxResults: 10 }
  label?: string        // disambiguate multiple accounts
}
// Returns: API response data
```

### Service Registry

Static configuration that tells both the agent and the shell UI what services are available:

```typescript
const SERVICE_REGISTRY = {
  gmail: {
    name: 'Gmail',
    category: 'google',
    pipedream_app: 'gmail',
    icon: 'gmail',
    actions: {
      list_messages: { description: 'List emails', params: { query: 'string', maxResults: 'number' } },
      get_message: { description: 'Read a specific email', params: { messageId: 'string' } },
      send_email: { description: 'Send an email', params: { to: 'string', subject: 'string', body: 'string' } },
      search: { description: 'Search emails', params: { query: 'string' } },
      list_labels: { description: 'List email labels', params: {} },
    },
  },
  google_calendar: {
    name: 'Google Calendar',
    category: 'google',
    pipedream_app: 'google_calendar',
    icon: 'calendar',
    actions: {
      list_events: { description: 'List upcoming events', params: { timeMin: 'string', timeMax: 'string' } },
      create_event: { description: 'Create an event', params: { summary: 'string', start: 'string', end: 'string' } },
      update_event: { description: 'Update an event', params: { eventId: 'string', summary: 'string' } },
      delete_event: { description: 'Delete an event', params: { eventId: 'string' } },
    },
  },
  google_drive: {
    name: 'Google Drive',
    category: 'google',
    pipedream_app: 'google_drive',
    icon: 'drive',
    actions: {
      list_files: { description: 'List files', params: { query: 'string', maxResults: 'number' } },
      get_file: { description: 'Get file content', params: { fileId: 'string' } },
      upload_file: { description: 'Upload a file', params: { name: 'string', content: 'string', mimeType: 'string' } },
      share_file: { description: 'Share a file', params: { fileId: 'string', email: 'string', role: 'string' } },
    },
  },
  github: {
    name: 'GitHub',
    category: 'developer',
    pipedream_app: 'github',
    icon: 'github',
    actions: {
      list_repos: { description: 'List repositories', params: { sort: 'string' } },
      list_issues: { description: 'List issues', params: { repo: 'string', state: 'string' } },
      create_issue: { description: 'Create an issue', params: { repo: 'string', title: 'string', body: 'string' } },
      list_prs: { description: 'List pull requests', params: { repo: 'string', state: 'string' } },
      get_notifications: { description: 'Get notifications', params: {} },
    },
  },
  slack: {
    name: 'Slack',
    category: 'communication',
    pipedream_app: 'slack',
    icon: 'slack',
    actions: {
      send_message: { description: 'Send a message', params: { channel: 'string', text: 'string' } },
      list_channels: { description: 'List channels', params: {} },
      list_messages: { description: 'Read channel messages', params: { channel: 'string', limit: 'number' } },
      search: { description: 'Search messages', params: { query: 'string' } },
      react: { description: 'Add a reaction', params: { channel: 'string', timestamp: 'string', emoji: 'string' } },
    },
  },
  discord: {
    name: 'Discord',
    category: 'communication',
    pipedream_app: 'discord',
    icon: 'discord',
    actions: {
      send_message: { description: 'Send a message', params: { channelId: 'string', content: 'string' } },
      list_servers: { description: 'List servers', params: {} },
      list_channels: { description: 'List channels in a server', params: { serverId: 'string' } },
      list_messages: { description: 'Read channel messages', params: { channelId: 'string', limit: 'number' } },
    },
  },
} as const
```

The agent sees a summary of available + connected services in its prompt context. The full registry powers the shell settings UI.

### Shell Settings UI

Settings > Integrations panel in the web shell:

**Connected section**: Lists all connected services with service name, account label, account email, connection date, and [Disconnect] button. Status indicator (green = active, yellow = token expiring, red = revoked).

**Available section**: Grid of service cards for the 6 launch services. Each card: icon, name, [Connect] button. Click opens OAuth popup.

**Browse section** (future): Search across 3,000+ Pipedream-supported services.

The settings page uses the same gateway API endpoints. WebSocket push updates the UI in real-time when connections change (e.g., after completing OAuth in another tab).

## User Scenarios & Testing

### User Story 1 - Connect via Settings UI (Priority: P1)

A user opens Settings > Integrations, clicks [Connect] on Gmail, completes OAuth in a popup, and sees Gmail appear in their connected services list.

**Acceptance Scenarios**:

1. **Given** a user on the settings page, **When** they click [Connect] on Gmail, **Then** an OAuth popup opens. After authorization, the popup closes and Gmail appears in the connected list with the authed email address.
2. **Given** a user completing OAuth, **When** authorization fails or is cancelled, **Then** the settings page shows an error toast and no partial connection is saved.
3. **Given** a user with Gmail already connected, **When** they view settings, **Then** Gmail shows as connected with the option to disconnect or add another account.

### User Story 2 - Connect via Conversation (Priority: P1)

A user tells their AI "connect my Google Calendar." The agent returns an authorization link. After completing OAuth, the agent confirms the connection.

**Acceptance Scenarios**:

1. **Given** a user in conversation, **When** they say "connect my Google Calendar", **Then** the agent presents an authorization link, the user completes OAuth, and the agent confirms the connection is active.
2. **Given** a user with an existing connection, **When** they say "connect my Google Calendar", **Then** the agent informs them it's already connected and offers to reconnect or add another account.

### User Story 3 - Use Connected Services (Priority: P1)

A user with connected services asks the AI to act on their behalf.

**Acceptance Scenarios**:

1. **Given** Gmail connected, **When** user says "send an email to sara@example.com saying I'll be late", **Then** the agent sends the email via `call_service` and confirms delivery.
2. **Given** Google Calendar connected, **When** user says "what's on my calendar this week?", **Then** the agent retrieves and presents real events.
3. **Given** Slack connected, **When** user says "post 'deployment complete' in #engineering", **Then** the agent posts the message to the correct channel.
4. **Given** an unconnected service, **When** user says "check my Gmail", **Then** the agent says Gmail is not connected and offers to connect it (with a link to settings or an inline OAuth URL).

### User Story 4 - Manage Connections (Priority: P2)

Users view and manage connections through settings UI or conversation.

**Acceptance Scenarios**:

1. **Given** three connected services, **When** user views Settings > Integrations, **Then** all three are listed with names, accounts, and status.
2. **Given** Gmail connected, **When** user clicks [Disconnect] or says "disconnect my Gmail", **Then** the connection is removed from platform DB, Pipedream credentials are revoked, and UI updates.
3. **Given** a user with multiple Gmail accounts, **When** they say "send from my work email", **Then** the agent uses the connection labeled "Work Gmail".

### User Story 5 - Build Apps with Integrations (Priority: P2)

Users ask the AI agent to build apps that use connected services.

**Acceptance Scenarios**:

1. **Given** Gmail and Slack connected, **When** user says "build me an app that summarizes my unread emails every morning and posts to #daily on Slack", **Then** the agent writes an app that uses `call_service` for both Gmail and Slack, with a cron trigger.
2. **Given** GitHub connected, **When** user says "build a PR dashboard", **Then** the agent builds an app that fetches open PRs and displays them.

### User Story 6 - Proactive Integration Actions (Priority: P3)

The AI uses connected services proactively via cron and heartbeat.

**Acceptance Scenarios**:

1. **Given** Gmail connected with a scheduled check, **When** 7 AM arrives, **Then** the agent fetches unread emails, generates a summary, and delivers it through the user's preferred channel.
2. **Given** a running integration, **When** the OAuth token expires, **Then** Pipedream auto-refreshes. If manual re-auth is needed, the user is notified with a one-click reconnect.

### Edge Cases

- **OAuth token expires mid-conversation**: Pipedream handles auto-refresh. If re-auth is needed, the gateway pushes a notification and the agent pauses the action with a reconnect link.
- **API rate limiting**: Gateway tracks usage per service per user. When rate-limited, queues the request and informs the user of the delay.
- **Multiple accounts per service**: Supported via `account_label`. Agent disambiguates by label. Settings UI shows all accounts grouped under the service.
- **Cross-service chaining**: "Add my Gmail action items to my Google Calendar" chains `call_service` calls across services in one turn. No special plumbing needed -- the agent orchestrates.
- **Pipedream is down**: Gateway returns a clear error. Agent tells the user the integration service is temporarily unavailable.
- **User disconnects mid-app**: Apps using a disconnected service get an error on next `call_service`. Agent notifies the user that the app needs the service reconnected.

## Requirements

### Functional Requirements

- **FR-001**: Gateway MUST expose REST API endpoints for connecting, listing, disconnecting, and calling integrations.
- **FR-002**: Gateway MUST use Pipedream Connect SDK for OAuth flows, credential storage, token refresh, and API proxying.
- **FR-003**: Gateway MUST map authenticated Matrix OS users to Pipedream `external_user_id`.
- **FR-004**: Platform Postgres MUST store user records, connected services, user apps (local workspace metadata), event subscriptions, and billing data.
- **FR-005**: Platform Postgres MUST NOT store OAuth credentials -- only Pipedream account ID references.
- **FR-006**: Shell MUST provide a Settings > Integrations page for click-to-connect management.
- **FR-007**: Shell settings MUST update in real-time via WebSocket when connections change.
- **FR-008**: Kernel MUST expose `connect_service` and `call_service` IPC tools for the AI agent.
- **FR-009**: System MUST support multiple connections per service with user-assigned labels.
- **FR-010**: System MUST support 6 launch services: Gmail, Google Calendar, Google Drive, GitHub, Slack, Discord.
- **FR-011**: System MUST provide a service registry that powers both the agent's knowledge and the settings UI.
- **FR-012**: System MUST handle API rate limiting by queuing and informing the user.
- **FR-013**: System MUST support cross-service action chaining in a single conversation turn.
- **FR-014**: System MUST allow user apps to use `call_service` for integration access, with cron-triggered execution.

### Non-Functional Requirements

- **NFR-001**: Gateway returns OAuth URL within 5 seconds. The full user-facing flow (including consent screen interaction) should complete within 60 seconds of clicking Connect.
- **NFR-002**: API calls via `call_service` return within 5 seconds (excluding provider latency).
- **NFR-003**: All Pipedream SDK calls MUST have `AbortSignal.timeout()` -- 10s for API calls, 30s for OAuth flows.
- **NFR-004**: Gateway MUST NOT expose Pipedream project credentials to containers.
- **NFR-005**: Gateway MUST validate that the authenticated user owns the connection before proxying any `call_service` request.
- **NFR-006**: Platform database migrations MUST use Kysely migrator (consistent with spec 050).

## Key Entities

- **User**: A Matrix OS platform user. Clerk ID, handle, container mapping, plan, status.
- **Connected Service**: A user's authorized link to an external service. Service name, Pipedream account ID, label, status, scopes.
- **Service Registry**: Static catalog of available services with actions, parameters, and Pipedream app mappings.
- **User App**: A locally authored application in a user's workspace that may use connected services. Name, slug, description, services used. NOT the gallery listing (see spec 058).

## Security

- **Credential isolation**: OAuth tokens live in Pipedream's infrastructure, encrypted at rest. Platform DB only stores references.
- **Container isolation**: Containers never talk to Pipedream directly. All integration calls route through the gateway, which enforces ownership checks.
- **Scope control**: Each connection records the OAuth scopes granted. The agent sees what permissions it has before attempting actions.
- **Revocation**: Disconnecting a service calls Pipedream's API to revoke credentials, then removes the platform DB row.
- **No wildcard CORS**: Integration endpoints use the existing origin allowlist.
- **Input validation**: Service names validated against the registry. Action names validated against the service's action list. Parameters validated with Zod schemas.
- **Webhook verification**: The `/webhook/connected` endpoint verifies Pipedream's HMAC signature using the shared webhook secret before processing any payload. Invalid signatures return 401.

## Dependencies

- `@pipedream/sdk` -- Pipedream Connect SDK (TypeScript)
- Postgres (platform instance, separate from per-user instances in spec 050)
- Kysely -- query builder for platform DB
- Clerk -- user authentication (existing)
- Existing gateway (Hono), shell (Next.js), kernel IPC

## Cross-Spec Interface Contract (049 ↔ 058)

049 and 058 will be implemented in parallel. To prevent overlapping work, each spec has exclusive table ownership.

**049 provides (platform foundation)**:

- Platform Postgres connection, Kysely query builder, migration tooling
- `users` table (id, clerk_id, handle, display_name, email, container_id, plan, status)
- `connected_services` table
- `user_apps` table (local workspace metadata only -- no gallery semantics)
- `billing` table
- Service registry (available integrations, their actions/scopes)
- Integration manifest shape validation (see below)

**058 consumes and defines separately (gallery/marketplace domain)**:

- `app_listings` -- marketplace metadata, discovery, publishing
- `app_versions` -- versioned releases, changelogs, audit status
- `app_installations` -- who installed what, at which version
- `app_reviews` -- ratings, text reviews
- `security_audits` -- per-version audit results
- `organizations`, `org_memberships` -- 058 owns for now

**Foreign key contracts** (058 references 049):

- `app_listings.author_id` -> `users.id`
- `app_reviews.reviewer_id` -> `users.id`
- `app_installations.user_id` -> `users.id`
- `org_memberships.user_id` -> `users.id`

**049 does NOT own**: gallery listings, publishing flows, install/update/rollback UX, reviews, security audits, org management.

### Integration Manifest Contract

049 defines the manifest shape that apps declare for their integration requirements. This is used by 058 at publish/install time to validate integration dependencies.

```typescript
// Part of the app manifest (defined by 049, consumed by 058)
interface IntegrationManifest {
  integrations?: {
    required?: string[]   // e.g. ['gmail.read', 'gmail.send'] -- app won't function without these
    optional?: string[]   // e.g. ['slack.send_message'] -- enhances app but not required
  }
}
```

049 validates manifest entries against the service registry. 058 uses this at publish time (audit layer 1) and install time (prompt user to connect missing services).

### Minimum Unblocker for 058

058 may begin implementation once these are in place:

1. Postgres connection + Kysely migration tooling operational
2. `users` table populated (Clerk auth -> user record creation)
3. Service registry readable (even if no OAuth flows work yet)

058 does NOT depend on:

- 049 OAuth connect flows being complete
- 049 billing being implemented
- 049 event subscriptions / webhook ingestion

## Scope Boundaries

**In scope**:
- Platform Postgres database (users, connected_services, user_apps, billing, event_subscriptions)
- Pipedream Connect integration for OAuth and API proxy
- Gateway REST API for integration management
- IPC tools (`connect_service`, `call_service`) for the AI agent
- Shell Settings > Integrations page (connect, disconnect, view status)
- Service registry for 6 launch services
- User apps using `call_service` with cron triggers

**Out of scope (future)**:
- Event streaming / real-time webhook ingestion (event_subscriptions table is reserved but not implemented)
- n8n self-hosted alternative (revisit when needed)
- App gallery / marketplace (owned by spec 058 -- gallery listings, versions, installs, reviews, security audits)
- Browse all 3,000+ Pipedream services in settings (launch with 6, expand later)
- Native file-system sync connectors (agent builds this per-user as apps instead)
- Visual workflow editor

## Future: Event Streaming (Phase 2)

Once the connect-and-call foundation is solid, add event streaming:

1. Pipedream event sources collect events (webhooks + polling) for connected services
2. Events flow to a central message bus (Redis Streams or NATS)
3. Gateway fans out events to user containers
4. Events persist in the user's container for the agent to process
5. `event_subscriptions` table tracks what each user is listening for

This enables "my computer receives everything" -- bank transactions, email arrivals, PR reviews, Slack mentions -- all flowing into the user's Matrix OS container for the AI to act on.

## Phase 2: Pipedream Actions API Integration

Phase 1 (implemented) established OAuth, platform DB, settings UI, and IPC tools. Phase 2 makes `call_service` actually work by using Pipedream's Actions API instead of the raw proxy.

### Problem

The current `call_service` IPC tool and `POST /api/integrations/call` route accept an action name (e.g., `list_messages`) but have no way to execute it. The Pipedream proxy API requires a raw HTTP URL, which means we'd need to know every service's API structure. Pipedream's Actions API solves this -- 10,000+ pre-built components handle the API details.

### Architecture

```
call_service("gmail", "list_messages", { query: "is:unread" })
  │
  ▼
Gateway maps action to Pipedream component key:
  "gmail" + "list_messages" → "gmail-list-messages"
  │
  ▼
client.actions.run({
  externalUserId: "dev",
  id: "gmail-list-messages",
  configuredProps: {
    gmail: { authProvisionId: "apn_V1hxyb6" },  // from connected_services
    query: "is:unread"
  }
})
  │
  ▼
Pipedream executes the action, returns:
{ exports: { "$summary": "Found 5 messages" }, ret: [...messages] }
```

### Component Key Convention

Pipedream component keys follow the pattern `{app_slug}-{action_name}`. Our registry maps our action names to component keys:

| Service | Action | Pipedream Component Key |
|---------|--------|------------------------|
| gmail | list_messages | gmail-list-messages |
| gmail | send_email | gmail-send-email |
| google_calendar | list_events | google_calendar-list-events |
| google_calendar | create_event | google_calendar-create-event |
| github | list_repos | github-list-repos |
| slack | send_message | slack-send-message |
| discord | send_message | discord-send-message |

Note: Actual Pipedream component keys may differ. Discovery step: call `client.actions.list({ app: "gmail" })` to get real keys and map them.

### Action Discovery

Before hardcoding component keys, the gateway should discover available actions per service at startup:

```typescript
const actions = await client.actions.list({ app: "gmail" });
// Returns: [{ key: "gmail-send-email", name: "Send Email", ... }, ...]
```

This populates a runtime action map that bridges our registry action names to real Pipedream component keys.

### Dynamic Properties

Some actions have dynamic properties (e.g., Slack's `send_message` needs to list channels first). The gateway handles this by calling `client.components.configureProps()` to resolve dynamic options before running the action.

### Requirements (Phase 2)

- **FR-015**: Gateway MUST use Pipedream Actions API (`client.actions.run()`) for `call_service`, not the raw proxy.
- **FR-016**: Gateway MUST discover available Pipedream component keys per service at startup via `client.actions.list()`.
- **FR-017**: Gateway MUST map connected account's `pipedream_account_id` to `authProvisionId` in `configuredProps`.
- **FR-018**: Gateway MUST handle dynamic properties by calling `configureProps()` when an action has `remoteOptions`.
- **FR-019**: Service registry MUST store Pipedream component key mappings alongside our action definitions.

## Clarifications

### Session 2026-04-05

- Q: Should 049 own the `apps` table with gallery fields, or narrow it? -> A: Rename to `user_apps`, strip gallery fields (`is_public`, `installs`). Local workspace metadata only. Gallery tables (`app_listings`, `app_versions`, `app_installations`, `app_reviews`, `security_audits`) are exclusively owned by spec 058.
- Q: What is the interface boundary between 049 and 058? -> A: 049 provides platform Postgres, `users`, `connected_services`, service registry, integration manifest validation. 058 consumes those and defines all gallery/marketplace tables independently, referencing `users.id` via foreign keys.
- Q: What does 058 need from 049 to start? -> A: Postgres connection + migration tooling, `users` table populated, service registry readable. 058 does not depend on OAuth flows or billing.
- Q: Should 049 define integration manifest shape? -> A: Yes. 049 defines `integrations.required` and `integrations.optional` manifest fields, validates against service registry. 058 consumes at publish/install time.
- Q: Who owns orgs? -> A: 058 owns `organizations` and `org_memberships` for now. May move to a platform spec later.
