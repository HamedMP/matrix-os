# Spec 049: Platform Integrations

**Created**: 2026-03-16
**Updated**: 2026-04-05
**Status**: Draft (v2)

## Overview

Matrix OS is a platform where every user has a computer in the cloud. To make those computers useful, users need to connect their existing tools -- Gmail, Calendar, Drive, GitHub, Slack, Discord -- so their AI coding agent can read, write, and build apps on top of real data.

This spec covers three things:

1. **Platform database** -- centralized Postgres for managing users, connections, apps, and billing across the entire Matrix OS platform
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
├── apps (all user-built apps on the platform, not just integration-using ones)
│   ├── id (uuid, PK)
│   ├── user_id (uuid, FK → users)
│   ├── name (text)
│   ├── slug (text)                       -- unique per user
│   ├── description (text)
│   ├── services_used (text[])            -- ['gmail', 'slack'] or []
│   ├── is_public (boolean, default false)-- shared to app store
│   ├── installs (integer, default 0)
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

**Using a service (API call):**

```
Agent: call_service("gmail", "list_messages", { query: "is:unread" })
  │
  ▼
Gateway ──▶ Pipedream Connect Proxy ──▶ Gmail API
  │                                        │
  ◀────────────── response ────────────────┘
  │
  ▼
Agent receives unread emails
```

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

All endpoints require authentication (Clerk session or container IPC token). The gateway maps the authenticated user to their `pipedream_external_id` for all Pipedream SDK calls.

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
- **FR-004**: Platform Postgres MUST store user records, connected services, apps, event subscriptions, and billing data.
- **FR-005**: Platform Postgres MUST NOT store OAuth credentials -- only Pipedream account ID references.
- **FR-006**: Shell MUST provide a Settings > Integrations page for click-to-connect management.
- **FR-007**: Shell settings MUST update in real-time via WebSocket when connections change.
- **FR-008**: Kernel MUST expose `connect_service` and `call_service` IPC tools for the AI agent.
- **FR-009**: System MUST support multiple connections per service with user-assigned labels.
- **FR-010**: System MUST support 6 launch services: Gmail, Google Calendar, Google Drive, GitHub, Slack, Discord.
- **FR-011**: System MUST provide a service registry that powers both the agent's knowledge and the settings UI.
- **FR-012**: System MUST handle API rate limiting by queuing and informing the user.
- **FR-013**: System MUST support cross-service action chaining in a single conversation turn.
- **FR-014**: System MUST allow apps to use `call_service` for integration access, with cron-triggered execution.

### Non-Functional Requirements

- **NFR-001**: OAuth connection flow completes in under 60 seconds.
- **NFR-002**: API calls via `call_service` return within 5 seconds (excluding provider latency).
- **NFR-003**: All Pipedream SDK calls MUST have `AbortSignal.timeout()` -- 10s for API calls, 30s for OAuth flows.
- **NFR-004**: Gateway MUST NOT expose Pipedream project credentials to containers.
- **NFR-005**: Gateway MUST validate that the authenticated user owns the connection before proxying any `call_service` request.
- **NFR-006**: Platform database migrations MUST use Kysely migrator (consistent with spec 050).

## Key Entities

- **User**: A Matrix OS platform user. Clerk ID, handle, container mapping, plan, status.
- **Connected Service**: A user's authorized link to an external service. Service name, Pipedream account ID, label, status, scopes.
- **Service Registry**: Static catalog of available services with actions, parameters, and Pipedream app mappings.
- **App**: A user-built application that may use connected services. Name, description, services used, public/private.

## Security

- **Credential isolation**: OAuth tokens live in Pipedream's infrastructure, encrypted at rest. Platform DB only stores references.
- **Container isolation**: Containers never talk to Pipedream directly. All integration calls route through the gateway, which enforces ownership checks.
- **Scope control**: Each connection records the OAuth scopes granted. The agent sees what permissions it has before attempting actions.
- **Revocation**: Disconnecting a service calls Pipedream's API to revoke credentials, then removes the platform DB row.
- **No wildcard CORS**: Integration endpoints use the existing origin allowlist.
- **Input validation**: Service names validated against the registry. Action names validated against the service's action list. Parameters validated with Zod schemas.

## Dependencies

- `@pipedream/sdk` -- Pipedream Connect SDK (TypeScript)
- Postgres (platform instance, separate from per-user instances in spec 050)
- Kysely -- query builder for platform DB
- Clerk -- user authentication (existing)
- Existing gateway (Hono), shell (Next.js), kernel IPC

## Scope Boundaries

**In scope**:
- Platform Postgres database (users, connected_services, apps, billing, event_subscriptions)
- Pipedream Connect integration for OAuth and API proxy
- Gateway REST API for integration management
- IPC tools (`connect_service`, `call_service`) for the AI agent
- Shell Settings > Integrations page (connect, disconnect, view status)
- Service registry for 6 launch services
- Apps using `call_service` with cron triggers

**Out of scope (future)**:
- Event streaming / real-time webhook ingestion (event_subscriptions table is reserved but not implemented)
- n8n self-hosted alternative (revisit when needed)
- App store / template marketplace (apps table supports `is_public` but no discovery UI yet)
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
