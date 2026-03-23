# Feature Specification: Hybrid Integration System

**Created**: 2026-03-16
**Status**: Draft

## Overview

Matrix OS needs to "plug into everything you already use" -- Google Calendar, Gmail, Slack, Discord, GitHub, CRMs, and 3,000+ other services. Users configure integrations through conversation ("connect my Gmail"), and the AI acts on their behalf across all connected services.

The system uses a hybrid approach:
1. **Pipedream Connect SDK** as the universal integration layer (3,000+ APIs, managed OAuth, API proxy)
2. **Native connectors** for 5 critical services with deep file-system-native behavior
3. **n8n self-hosted** as an optional power-user alternative for full data sovereignty

No MCPs. Direct SDK calls and API proxy only.

## User Scenarios & Testing

### User Story 1 - Connect a Service Through Conversation (Priority: P1)

A user tells their AI "connect my Google Calendar." The OS initiates an OAuth flow, the user authorizes access in their browser, and the connection is saved. From that point on, the AI can read and write to that service on the user's behalf.

**Why this priority**: Foundational. Every other story depends on this.

**Independent Test**: Ask the AI to connect Google Calendar, complete OAuth, verify the connection persists in `~/system/integrations.json`.

**Acceptance Scenarios**:

1. **Given** a user with no connected services, **When** they say "connect my Google Calendar", **Then** the OS presents an authorization link, the user completes OAuth, and the connection is stored in `~/system/integrations.json`.
2. **Given** a user with an existing Google Calendar connection, **When** they say "connect my Google Calendar", **Then** the OS informs them the service is already connected and offers to reconnect or disconnect.
3. **Given** a user completing OAuth, **When** authorization fails or is cancelled, **Then** the OS informs the user and no partial connection is saved.

---

### User Story 2 - Use a Connected Service Through Conversation (Priority: P1)

A user with connected services asks the AI to act: "What's on my calendar today?", "Send an email to Sara about the meeting", "Post a message in #general on Slack."

**Why this priority**: Connecting without using has no value. This is the other half of the core loop.

**Independent Test**: Connect Google Calendar, ask "What's on my calendar today?", verify the AI returns real events.

**Acceptance Scenarios**:

1. **Given** a user with Gmail connected, **When** they say "send an email to sara@example.com saying I'll be late", **Then** the AI sends the email and confirms delivery.
2. **Given** a user with Google Calendar connected, **When** they say "what's on my calendar this week?", **Then** the AI retrieves and presents real calendar events.
3. **Given** a user with Slack connected, **When** they say "post 'deployment complete' in #engineering", **Then** the AI posts the message to the correct channel.
4. **Given** a user requesting an action on an unconnected service, **When** they say "check my Gmail", **Then** the AI says Gmail is not connected and offers to connect it.

---

### User Story 3 - View and Manage Connections (Priority: P2)

A user asks "what services are connected?" or "disconnect my GitHub." The AI shows all connected integrations and can disconnect individual services.

**Why this priority**: Users need visibility and control over what their AI has access to.

**Independent Test**: Connect 2-3 services, ask "what's connected?", verify the list, disconnect one, verify removal.

**Acceptance Scenarios**:

1. **Given** a user with three connected services, **When** they say "what services are connected?", **Then** the AI lists all services with names, account identifiers, and connection timestamps.
2. **Given** a user with Gmail connected, **When** they say "disconnect my Gmail", **Then** the connection is removed from `~/system/integrations.json` and the AI confirms.
3. **Given** a user with no connected services, **When** they say "what's connected?", **Then** the AI says nothing is connected and suggests popular services.

---

### User Story 4 - Native Connector Deep Integration (Priority: P2)

For five critical services (Google Calendar, Gmail, Slack, Discord, GitHub), the AI provides deep file-system-native behavior. Calendar events sync to local files. Email summaries are saved as markdown. GitHub notifications become tasks.

**Why this priority**: Native connectors differentiate Matrix OS from "just another API wrapper." File-system-native behavior makes integrations feel like part of the OS.

**Independent Test**: Connect Google Calendar with the native connector, verify events appear as files in `~/data/calendar/`.

**Acceptance Scenarios**:

1. **Given** a user with Google Calendar connected via native connector, **When** events sync, **Then** events are saved as structured files in `~/data/calendar/` that the user can inspect, edit, or share.
2. **Given** a user with Gmail connected via native connector, **When** the user asks for a daily email summary, **Then** the AI produces a markdown summary saved in `~/data/email/`.
3. **Given** a user with GitHub connected via native connector, **When** new notifications arrive, **Then** they are transformed into task entries the AI can reference.

---

### User Story 5 - Proactive Integration Actions (Priority: P3)

The AI uses connected services proactively via cron and heartbeat. "Check my email every morning at 7 AM and summarize." "Notify me on Telegram when someone mentions me on Slack."

**Why this priority**: The "works while you sleep" promise applied to integrations. Builds on all previous stories.

**Independent Test**: Set up "check my Gmail at 7 AM and summarize", wait for the trigger, verify the summary appears.

**Acceptance Scenarios**:

1. **Given** a user with Gmail connected and a cron job, **When** 7 AM arrives, **Then** the AI fetches unread emails, generates a summary, and delivers it through the user's preferred channel.
2. **Given** a proactive integration running, **When** the OAuth token expires, **Then** the system attempts automatic refresh and only notifies the user if manual re-auth is needed.

---

### User Story 6 - Self-Hosted Integration Path (Priority: P3)

A power user uses n8n (self-hosted) instead of Pipedream Connect. They run n8n locally, configure their own OAuth apps, and the kernel routes integration calls through their local n8n instance.

**Why this priority**: Important for data sovereignty but serves a smaller audience.

**Independent Test**: Run n8n locally, configure Matrix OS to use it for Google Calendar, verify operations work through the local instance.

**Acceptance Scenarios**:

1. **Given** a user with n8n running locally, **When** they configure Matrix OS to use n8n, **Then** all integration calls route through their local instance.
2. **Given** a user using n8n, **When** they connect a service, **Then** OAuth credentials are stored only on their local n8n instance.

---

### Edge Cases

- OAuth token expires mid-conversation: attempt silent refresh, only interrupt user if re-auth required.
- API rate limiting: queue requests and inform user of delays rather than failing silently.
- User is offline: use cached/synced data from native connectors when available, communicate that live data requires connectivity.
- Cross-service chaining: "add my Gmail action items to my Google Calendar" should chain calls across services in one turn.
- Multiple accounts per service: support personal Gmail + work Gmail with user-assigned labels.
- Pipedream proxy is down: native connectors continue working, proxy-dependent services show clear status.

## Requirements

### Functional Requirements

- **FR-001**: System MUST provide an IPC tool (`connect_service`) that initiates OAuth flows for any supported service, presenting an authorization link to the user.
- **FR-002**: System MUST provide an IPC tool (`call_service`) that makes authenticated API calls to connected services, with the integration layer handling credential injection.
- **FR-003**: System MUST persist all connection state in `~/system/integrations.json`, including service name, account identifier, account label, connection status, and timestamp.
- **FR-004**: System MUST support multiple connections per service with user-assigned labels.
- **FR-005**: System MUST automatically refresh expired OAuth tokens without user intervention when possible.
- **FR-006**: System MUST provide native connectors for five critical services: Google Calendar, Gmail, Slack, Discord, and GitHub, with file-system-native data sync.
- **FR-007**: Native connectors MUST sync service data to structured files in `~/data/{service-name}/`.
- **FR-008**: System MUST support listing all connected services with their status and account identifiers.
- **FR-009**: System MUST support disconnecting a service, removing credentials and stopping data sync.
- **FR-010**: System MUST allow proactive integration actions through cron jobs and heartbeat.
- **FR-011**: System MUST support an alternative self-hosted integration backend (n8n) that handles OAuth and API calls locally.
- **FR-012**: System MUST expose available services as a knowledge file so the AI knows what integrations are possible.
- **FR-013**: System MUST handle API rate limiting by queuing requests and informing the user.
- **FR-014**: System MUST support chaining calls across multiple connected services in a single conversation turn.

### Key Entities

- **Integration Connection**: A user's authorized link to an external service. Service name, account ID, label, status (active/expired/disconnected), timestamp, backend (pipedream/n8n/native).
- **Native Connector**: A deep integration module for a critical service that syncs data to the local file system. Service name, sync config, local data path, sync schedule.
- **Service Registry**: Catalog of all available services. Service name, category, available operations, auth method, whether a native connector exists.
- **Integration Backend**: The system handling OAuth and API proxying. Two backends: Pipedream Connect (cloud, 3,000+ services) and n8n (self-hosted).

## Success Criteria

### Measurable Outcomes

- **SC-001**: Users can connect a new service through conversation in under 60 seconds.
- **SC-002**: Users can perform actions on connected services with a single natural language request, results returned within 5 seconds.
- **SC-003**: At least 3,000 services available for connection through the universal integration layer.
- **SC-004**: Five native connectors provide file-system-native data sync with data inspectable as files.
- **SC-005**: All connection state stored as a human-readable file (`~/system/integrations.json`).
- **SC-006**: OAuth token refresh succeeds silently in 95%+ of cases.
- **SC-007**: Users can switch from cloud to self-hosted integration backend without losing functionality.
- **SC-008**: Proactive integration actions execute with the same reliability as the existing cron system.

## Assumptions

- Pipedream Connect SDK is available as a TypeScript library importable directly into the kernel (not MCP).
- Pipedream's API proxy handles credential injection and token refresh transparently -- the kernel only stores account identifiers.
- User's Pipedream project credentials (client ID/secret) are stored in `~/system/config.json`.
- n8n runs as a sidecar Docker container accessible via local HTTP API.
- Native connectors build on `call_service` but add file-system sync as a layer above the API calls.
- Existing cron and heartbeat systems are sufficient for scheduling proactive integration actions.

## Dependencies

- Pipedream Connect SDK (`@pipedream/sdk`)
- Existing IPC MCP server for new `connect_service` and `call_service` tools
- Existing cron and heartbeat systems
- Existing file watcher for `~/system/integrations.json` changes
- n8n Docker image for self-hosted path

## Scope Boundaries

**In scope**:
- Universal integration layer via Pipedream Connect SDK (3,000+ services)
- Five native connectors with file-system-native behavior
- IPC tools for connecting, calling, listing, and disconnecting services
- Integration state persistence in `~/system/integrations.json`
- Proactive integration actions via cron/heartbeat
- Self-hosted n8n as alternative backend
- Knowledge file listing available services

**Out of scope**:
- Building custom OAuth flows per service (Pipedream handles this)
- MCP-based integration approach (explicitly rejected)
- Real-time webhook listeners for external events (future spec)
- Integration marketplace for sharing connector configs (future spec)
- Visual workflow editor (n8n provides this for power users)
