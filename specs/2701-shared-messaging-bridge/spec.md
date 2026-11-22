# Feature Specification: Shared Messaging Bridge (Phase 0)

**Feature Branch**: `feat/eng-535-shared-messaging-bridge`
**Created**: 2026-11-22
**Status**: Draft, phase 0 (allowlisted owners only)
**Ticket**: [ENG-535](https://linear.app/matrix-os/issue/ENG-535/connect-whatsapp-telegram-and-linkedin-through-a-shared-bridge-server)
**Supersedes**: the per-VPS hosting decision in `specs/077-matrix-messaging-bridge/`. Its
permission, audit, draft and automation model stays in force.
**Shared contract**: `packages/contracts/src/messaging-bridge.ts` (source of truth for every
payload named below).

## Goal

An owner links their own WhatsApp, Telegram and LinkedIn accounts inside their Matrix
instance, sees real conversations and messages arrive, and sends a reply from Matrix. Phase 0
proves this end to end for an allowlisted owner and records the measurements needed to decide
the production shape.

## What changes from spec 077

| Topic | Spec 077 | This spec |
| --- | --- | --- |
| Where bridges run | Synapse and bridges on every customer VPS | One shared bridge host for all owners |
| Customer VPS floor | 2 vCPU / 6 GiB / 60 GiB | No change to the VPS; nothing is installed on it |
| Networks | Telegram, WhatsApp | WhatsApp, Telegram, LinkedIn |
| Account linking | Stub provider returning a fake QR string | Real bridge login flows |
| Inbound messages | Custom ingest endpoint, event id only | Gateway syncs as a Matrix client and stores messages |
| Outbound | Reply stops at `sending` | Reply is sent through the homeserver |

## Constitution deviation (needs sign-off before any non-allowlisted owner)

Principle I says no data lives outside the owner's control. A shared bridge host holds, on
platform infrastructure:

- the bridge login sessions for each linked chat account (WhatsApp device keys, Telegram
  session, LinkedIn cookies), and
- a transient copy of bridged messages in the shared homeserver database.

Phase 0 accepts this for allowlisted owners who opt in, with these limits:

- Canonical message history is the owner's Postgres on their VPS. The homeserver copy is a
  relay buffer with a retention purge (default 7 days).
- The homeserver is closed: no federation, no open registration, no public room directory.
- Each owner gets one homeserver user that no other owner can read. Bridges run with
  per-user isolation; no relay mode, no shared portals.
- Unlinking an account logs it out at the bridge and deletes the bridge session.
- An owner can export and delete their messaging data from their own Postgres at any time.

Recommended reviewers before widening access: product owner and security owner. A per-VPS or
per-owner-isolated bridge tier remains the long-term option for owners who require it.

## Architecture

```
Renderer (Web Canvas / Web Desktop / Electron Desktop)
   |  /api/messages/bridge/*  + owner WebSocket "messages:changed"
Gateway on the owner VPS
   |-- link / unlink / session ------------> Platform  /internal/messaging-bridge/*
   |                                             |  shared secrets, owner allowlist
   |                                             v
   |-- Matrix client API (owner token) ----> Bridge host: homeserver + whatsapp,
        sync, send, room state                    telegram, linkedin bridges
```

- **Bridge host** (`distro/messaging-bridge-host/`): one dedicated server running a closed
  homeserver, its Postgres, the three mautrix bridges, and a TLS reverse proxy. It is platform
  infrastructure, not customer runtime, so it ships as a pinned Docker Compose bundle with a
  bootstrap script that generates all secrets and configs.
- **Platform** (`packages/platform/src/messaging-bridge/`): the only holder of bridge-host
  secrets. It ensures an owner's homeserver identity, mints that owner's access token, and
  proxies bridge login flows. It never relays message content.
- **Gateway** (`packages/gateway/src/messages/`): a Matrix client for exactly one owner. It
  runs the sync loop, stores messages in owner Postgres, sends replies, and exposes the owner
  API. It reuses the 077 repository, permissions, audit and drafts.
- **Renderers** (`packages/ui/src/messaging/` mounted by `shell/` and `desktop/`): shared
  components for linking accounts and for the inbox.

## User stories

### US1: Link a chat account (P1)

1. **Given** an allowlisted owner on Settings, Messaging, **When** they choose WhatsApp,
   **Then** a real QR code appears, and after scanning it the account shows Connected.
2. **Given** the owner chooses Telegram, **When** they enter their phone number and the code
   Telegram sends (and a password if they have one), **Then** the account shows Connected.
3. **Given** the owner chooses LinkedIn, **When** they follow the on-screen steps and submit
   the requested values, **Then** the account shows Connected.
4. **Given** a link attempt expires or is rejected, **Then** the owner sees a plain retry
   message and no partial account remains.
5. **Given** an owner who is not allowlisted, **Then** Messaging shows "Not available yet" and
   no link action.

### US2: See conversations and messages (P1)

1. **Given** a linked account, **When** a new message arrives in that app, **Then** it
   appears in the Matrix inbox within 10 seconds without a manual refresh.
2. **Given** several linked networks, **Then** the conversation list shows all of them, newest
   first, each labelled with its network, and can be filtered by network.
3. **Given** the gateway restarts, **Then** sync resumes from its stored position with no
   duplicate and no missing message.

### US3: Reply from Matrix (P1)

1. **Given** an open conversation, **When** the owner sends a text, **Then** it is delivered
   in the original app and shown as sent.
2. **Given** the send fails, **Then** the message shows failed with a retry action and the
   typed text is not lost.

### US4: Unlink (P2)

1. **Given** a connected account, **When** the owner removes it and confirms, **Then** the
   bridge session is logged out and the account disappears only after the server confirms.

### Deferred (not phase 0)

Agent tools for reading and replying, media sending, reactions, edits, deletes, read
receipts, typing, an explicit mark-read action, group management, history backfill beyond what the bridge delivers at link
time, end-to-bridge encryption, Web Mobile and Native Mobile, a standalone Messages window,
networks other than the three above, logging out bridge accounts when a Matrix account is
deleted, revoking superseded owner tokens, WhatsApp accounts that require a passkey step, and
the 077 recovery actions.

Known gaps carried from 077, to close with agent access: the Hermes `send_if_allowed` reply
path still records a reply as sent without delivering it. Approved drafts do deliver.

Left in place for a follow-up: the 077 `home/apps/messages` app. It has no manifest, so it
never appears in the launcher, and it calls the gateway with `fetch`, which the app sandbox
blocks, so it was already unreachable. Its setup route no longer exists. Removing it touches
the home template manifest and existing owner homes, which needs its own reviewed change.

## Affected surfaces

| Surface | In phase 0 | Note |
| --- | --- | --- |
| Web Canvas | yes | Settings, Messaging |
| Web Desktop | yes | Settings, Messaging |
| Electron Desktop | yes | Settings, Messaging; same shared components |
| Web Mobile | N/A | deferred; needs reviewer approval |
| Native Mobile | N/A | deferred; needs reviewer approval |

The existing WhatsApp panel in Settings, Messaging (talk to your agent over WhatsApp) stays
unchanged. The new section is titled "Your chat apps" so the two are not confused.

## Contracts

All payload schemas live in `packages/contracts/src/messaging-bridge.ts`.

### Gateway to platform (`/internal/messaging-bridge`)

Auth: the existing machine credential the gateway already uses for platform-owned routes
(`UPGRADE_TOKEN` plus `MATRIX_HANDLE`), verified exactly as the integrations proxy verifies
it. The owner identity is derived from the verified handle, never from the request body.

| Method and path | Body | Response |
| --- | --- | --- |
| `POST /session` | none | `MessagingBridgeSession` |
| `GET /:network/login/flows` | none | `MessagingBridgeLoginFlowsResponse` |
| `POST /:network/login/start` | `MessagingBridgeLoginStartRequest` | `MessagingBridgeLoginProgress` |
| `POST /:network/login/step` | `MessagingBridgeLoginStepRequest` | `MessagingBridgeLoginProgress` |
| `POST /:network/login/cancel` | `MessagingBridgeLoginCancelRequest` | `{ ok: true }` |
| `GET /:network/logins` | none | `MessagingBridgeLoginsResponse` |
| `POST /:network/logout` | `MessagingBridgeLogoutRequest` | `{ ok: true }` |

Errors use `MessagingBridgeError`. An owner outside the allowlist gets `403 not_enabled`. A
missing bridge-host configuration gets `503 misconfigured`, never 404.

### Renderer to gateway (`/api/messages/bridge`)

Auth: the normal request principal. All routes are owner-scoped.

| Method and path | Body or query | Response |
| --- | --- | --- |
| `GET /status` | none | `MessagingBridgeStatus` |
| `POST /:network/link` | `MessagingBridgeLinkStartRequest` | `MessagingBridgeLinkProgress` |
| `POST /:network/link/:linkId/step` | `MessagingBridgeLinkStepRequest` | `MessagingBridgeLinkProgress` |
| `POST /:network/link/:linkId/cancel` | none | `{ ok: true }` |
| `DELETE /:network/accounts/:accountId` | none | `{ ok: true }` |
| `GET /conversations` | `MessagingBridgeConversationsQuery` | `MessagingBridgeConversationsResponse` |
| `GET /conversations/:roomId/messages` | `MessagingBridgeMessagesQuery` | `MessagingBridgeMessagesResponse` |
| `POST /conversations/:roomId/send` | `MessagingBridgeSendRequest` | `MessagingBridgeMessage` |

The gateway broadcasts `MessagingBridgeChangedEvent` on the owner WebSocket after any
committed change. Clients refetch; the event carries no message content.

The 077 routes for permissions, drafts, automation, health and recovery remain. The 077 stub
setup routes (`/accounts/setup*`) and the stub provider are removed, with their tests replaced
by tests of the real link flow.

## Security architecture

**Auth matrix**

| Caller | Target | Credential | Authorization |
| --- | --- | --- | --- |
| Renderer | Gateway `/api/messages/bridge/*` | request principal | owner of this runtime |
| Gateway | Platform `/internal/messaging-bridge/*` | machine token + handle | handle resolves to an allowlisted owner |
| Gateway | Homeserver client API | that owner's access token | homeserver scopes it to that user |
| Platform | Homeserver admin API | admin token | platform only |
| Platform | Bridge provisioning APIs | per-bridge shared secret | platform only; acts for one derived user id |

- The owner's homeserver user id is derived on the platform from the owner id with a keyed
  hash (`@mxo_<32 hex>:<server name>`), so a gateway cannot name another owner's user. The
  `mxo_` prefix is the only namespace the double-puppet appservice may act for.
- The platform mints each owner token by appservice login on the fixed device
  `MATRIXOS_GATEWAY`, so the homeserver deduplicates send retries per device.
- Admin, provisioning and client-login paths on the bridge host also require a gate secret
  header that only the platform holds; without it the proxy answers 404.
- The owner access token is stored on the VPS in the owner secret store with mode 0600. It is
  never returned to a renderer, logged, or written to audit.
- Login field values, QR payloads and cookies pass through and are never logged or stored by
  the gateway or platform.
- The bridge host accepts only HTTPS. The reverse proxy exposes the client API paths the
  gateway needs, and exposes admin and provisioning paths only to callers presenting the
  platform secret. Federation ports are closed.

**Input validation**: every body, path param and query param is parsed with the shared Zod
schemas at the route boundary. Mutating routes, including `DELETE`, use `bodyLimit`.

**Outbound calls**: every `fetch` has `AbortSignal.timeout` (10 s; 35 s for the long-poll
step and for sync) and `redirect: "error"`. The homeserver URL comes only from the platform
session response and must be `https`.

**Error policy**: clients receive only `MessagingBridgeError` codes and fixed messages. Real
errors are logged server-side with secrets redacted. Bridge and provider names never appear
in an error body.

## Integration wiring

- **Gateway startup**: when `PLATFORM_INTERNAL_URL`, the machine credential and the owner
  database are present, construct the platform client and the sync service at registration
  time. If any is missing, `/api/messages/bridge/status` returns `availability: "unavailable"`
  and every other bridge route returns `503 misconfigured`.
- **Sync start**: the sync loop starts only after the owner has at least one linked account
  and a stored session; it is not started for owners who never open Messaging.
- **Platform config**: `MESSAGING_BRIDGE_HOST_URL`, `MESSAGING_BRIDGE_SERVER_NAME`,
  `MESSAGING_BRIDGE_ADMIN_TOKEN`, `MESSAGING_BRIDGE_GATE_SECRET`,
  `MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN`, `MESSAGING_BRIDGE_USER_ID_KEY`,
  `MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP`, `..._TELEGRAM`, `..._LINKEDIN`,
  `MESSAGING_BRIDGE_ALLOWED_HANDLES`. All but the allowlist come from the env block the
  bridge host's bootstrap writes. The routes always register; with any required value
  missing they answer `503 misconfigured`.
- **No `globalThis`**, no cross-package singletons; dependencies are injected.

## Data model (owner Postgres, added to the 077 tables)

- `messaging_bridge_sync_state`: `owner_id` (pk), `next_batch`, `updated_at`.
- `messaging_messages`: `owner_id`, `room_id`, `event_id`, `direction`, `sender_name`,
  `kind`, `body`, `occurred_at`, `delivery`, `client_txn_id`; unique
  `(owner_id, event_id)`; unique `(owner_id, client_txn_id)` where not null.
- `messaging_conversations` gains `last_message_preview` and `unread_count`; network slug
  accepts `linkedin`.

Platform Postgres: `messaging_bridge_identities`: `owner_id` (pk), `matrix_user_id`,
`created_at`. `messaging_bridge_logins`: `process_id` (pk), `owner_id`, `network`,
`matrix_user_id`, `expires_at`, so any platform instance can advance or cancel a pending
login it did not start. Rows are capped per owner, ownership is enforced in every `WHERE`
clause, and expired rows are deleted. No tokens, login field values and no message data are
stored on the platform.

## Failure modes

| Failure | Behaviour |
| --- | --- |
| Bridge host down | Sync backs off (1 s to 60 s, jittered). Status shows "Unavailable". Stored messages stay readable. |
| Limited sync timeline | Before advancing `next_batch`, sync backfills the gap with `/messages` from `prev_batch`, at most 10 pages of 100 events per room, each request with a timeout. A gap beyond that cap is logged and skipped. |
| Sync batch partly applied | Messages and `next_batch` commit in one transaction; replay is safe because inserts use `ON CONFLICT DO NOTHING`. |
| Send times out | Message stays `failed`; retry reuses `client_txn_id`, which is also the Matrix transaction id, so no duplicate is delivered. |
| Access token rejected | Gateway requests a new session once, then marks availability "unavailable". |
| Link flow abandoned | In-memory link sessions expire after 10 minutes and are swept; nothing is persisted. Dismissal, expiry and eviction also cancel the login at the bridge. |
| Bridge reports logged out | Account state becomes `needs_relink`; the inbox stays readable. |
| Gateway shutdown | Sync aborts its in-flight request and stops before the database is destroyed. |
| Two gateway processes | A Postgres advisory lock on the owner id ensures one sync loop. |

## Resource management

- Link sessions: in-memory map, cap 16 per owner, 10-minute TTL, periodic sweep, cleared on
  shutdown.
- Sync: one loop per owner, one request in flight, timeline limit 50 events per room per
  batch, limited-timeline backfill capped at 10 pages of 100 events per room, bodies
  truncated to the contract maximum.
- Platform pending logins: Postgres rows, cap 16 per owner, 10-minute expiry, expired rows
  deleted on each start; login starts are rate limited per owner from the same table.
- Message retention in owner Postgres: unlimited in phase 0; measured and reported.
- Bridge host: homeserver retention purge after 7 days; media cache capped; nightly database
  backup with 7-day rotation.
- Rate limits: link start 5 per owner per 10 minutes; send 30 per owner per minute.

## Phase 0 measurements to record (`spike-results.md`)

1. Bridge host memory and disk with 1 owner and 3 linked accounts, idle and after 24 hours.
2. Time from scan or code entry to Connected, per network.
3. Inbound latency from the source app to the Matrix inbox.
4. What history each bridge delivers at link time.
5. Whether each bridge's provisioning API matches the normalized login-step contract, and any
   field that needed special handling (LinkedIn in particular).
6. Any account warnings or logouts from the networks during the test.

## Acceptance checks

- All three accounts link on an allowlisted test instance.
- A message round-trips in each network: inbound appears in the inbox, a reply is delivered.
- A gateway restart produces no duplicate and no gap.
- A non-allowlisted owner sees no link action and receives `403 not_enabled` from the platform.
- `bun run typecheck`, `bun run check:patterns`, the focused messaging suites, and
  `bun run build:shell:production` pass.

## Risks

- **Account bans**: the WhatsApp and LinkedIn bridges are unofficial clients. Linking can
  trigger a warning or ban. The link screen must say so before the owner starts.
- **Shared-host blast radius**: one compromised host exposes every linked session. Mitigated
  by the closed homeserver, secret separation, and the allowlist during phase 0.
- **Bridge licensing**: the bridges are run unmodified as separate processes. Confirm their
  licence terms before any wider rollout.
- **LinkedIn login shape**: cookie-based login is awkward in a web UI and may need a
  different flow after the spike.
- **Bridge API drift**: bridge versions are pinned; upgrades are deliberate.

## Delivery plan

One GitHub native stack sharing ENG-535, in this order:

1. Spec and shared contract.
2. Bridge host bundle (`distro/messaging-bridge-host/`, deploy tests).
3. Bridge host operations (cloud-init, backup, health, runbook).
4. Platform routes (`packages/platform/src/messaging-bridge/`).
5. Gateway bridge clients and session store (`packages/gateway/src/messages/`).
6. Gateway sync, store, send and owner routes.
7. Renderer components and wiring (`packages/ui/src/messaging/`, `shell/`, `desktop/`).

Follow-up deliverable outside this stack:

8. Public documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`, covering
   account linking, what the shared host stores, and the phase 0 limits (allowlist,
   supported apps, account-ban risk). It ships before phase 0 opens beyond the allowlist.
