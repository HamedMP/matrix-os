# Agents & Providers Settings

Status: implementation in progress. User approved the reviewed Trellis plan on October 1, 2026.

## Product behavior

Settings presents Matrix AI first, Coding agents (Claude Code, Codex, OpenCode, Pi) second, and General agents (Hermes, OpenClaw) third. Each agent has one truthful status and an accessible accordion. Additional configured instances remain visible. Existing explicit Off, unknown authentication, account dependencies, route selection, budgets and allowlists survive the redesign through advanced controls.

The visual reference is [Settings canvas 1112:2178](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1112-2178). Overview, connected account and method chooser were read through Figma design context; the remaining device login, key validation, install and disconnect frames were inspected through user-authorized computer use. Sample balances, models, account identifiers, percentages and countdowns are not product data.

| Control | Authority and outcome |
| --- | --- |
| Refresh | Re-read current owner/computer capabilities and canonical provider snapshot |
| Matrix AI balance/models | Existing funded ledger summary and executable model inventory |
| Usage history | Bounded owner/computer ledger projection; unknown model stays unknown |
| Buy credit | Existing scoped, idempotent credit checkout; no automatic payment |
| Connect / Change account / Reconnect | Explicit supported native login or validated key submission |
| Device code / Copy / sign-in / Cancel | Foreground expiring operation; allowlisted URL and actual cancellation |
| Key Connect / retry / Back | Transient masked input; validate before saving, retain prior credential on failure |
| Install / Cancel | Fixed managed harness executable operation, real phase and canonical Terminal visibility |
| View logs | Bounded sanitized operation evidence, never arbitrary native output or secrets |
| Disconnect | Native logout with dependency checks; existing chats/projects/settings preserved |
| Also uninstall | Separately authorized managed executable removal, never saved instance removal or home deletion |

## Architecture and compatibility

ProviderSettingsSnapshot and canonical V3 remain the source of provider/access truth. Shared @matrix-os/ui owns presentation derivation; Web Canvas, Web Desktop and Electron Desktop consume the same component and typed operations. Renderer adapters own navigation and abortable runtime-bound transport. New workflow and history contracts are separate from historical strict snapshots and mutation receipts; capabilities are advertised only when dependencies exist at registration.

Native credential stores remain native. Secrets do not enter snapshots, generic mutation history, public logs or durable operation receipts. No automatic account migration, reassignment, enablement or changes to immutable existing Chat bindings. Unknown allowance and installation progress are shown honestly. Related durable writes follow existing serialized revision guards or Kysely transactions; no new embedded database.

One injected native-profile guard coordinates canonical and legacy login/logout, key verification/save, and managed install/uninstall for Claude and Codex. Admission checks persisted receipts and live canonical Terminal incarnations, including receipt-evicted sessions; an expired receipt alone cannot release a live process. Exact idempotent recovery may resume its own operation. A lease releases only after confirmed exit/reaping, and ambiguous launch or failed cleanup retains protection. Direct owner Terminal commands remain outside API serialization; fresh credential fingerprints and readback establish observed current authentication mode rather than a universal filesystem lock.

Authorized workflow capabilities may expose an active operation ID for the exact harness. A fresh Settings view retrieves that scoped receipt to restore status and cancellation. Renderer GET requests have a 15-second deadline and mutations a 90-second deadline, independent of the native operation lifetime. An uncertain start retry retains its idempotency key; a lost key-save response reports uncertainty instead of claiming rejection or successful replacement.

Canonical model capabilities are returned only when the caller explicitly requests `includeModelCapabilities=true`, including action responses. Historical strict clients keep their previous model shape. Capability badges display supplied Tools, Vision, Reasoning, Long context or Audio metadata; discovered models with no authoritative capability metadata have no invented badge.

Native guided device login is available for Codex; Claude uses its native Terminal login. Guided API-key validation/save is available for installed Codex with the OpenAI adapter. Other harnesses retain their supported Terminal/configuration flows. Capabilities determine the available controls; an unsupported native method is never advertised. A successful native login remains a local observation until remote readiness is established. Verified Codex key mode preserves the canonical account/source IDs while truthfully reporting API-key funding and authentication.

The native workflow has a ten-minute deadline. Hermes/OpenClaw install cancellation stops the fixed systemd cgroup, terminates the exact Terminal incarnation, then stops the cgroup again to cover startup races. The host installer has an independent upper-bound deadline. Failed cleanup keeps the operation retryable and cannot report successful cancellation. Root-owned uninstall opt-out markers prevent background sync from reinstalling an intentionally removed agent. Owner chats, projects and configuration remain intact.

### Endpoint contract

| Endpoint | Payload / result |
| --- | --- |
| `GET /api/ai/provider-settings/workflows/capabilities` | At most 32 authoritative harness capabilities |
| `POST /api/ai/provider-settings/workflows` | Strict harness ID, operation kind, supported login method and idempotency key; safe expiring receipt |
| `GET /api/ai/provider-settings/workflows/:id` | Owner-scoped operation status |
| `POST /api/ai/provider-settings/workflows/:id/cancel` | Strict empty body; actual cleanup before cancelled receipt |
| `POST /api/ai/provider-settings/workflows/keys` | Strict bounded masked-input transport; returns only verified boolean |
| `GET /api/ai/provider-settings/workflows/logs/:harnessInstanceId` | At most 64 semantic events, with no raw native output |
| `GET /billing/ai-credit/history` | Strict runtime slot, limit 1–50 and opaque cursor; scoped signed ledger amounts |

Workflow bodies are limited to 8 KiB, operations to 64 retained entries and four queued actions, and key verification to 12 probes per minute. OpenAI verification uses the fixed non-billable models endpoint with a ten-second timeout and rejects redirects. Codex key saving runs the pinned native CLI with stdin in a disposable private staging directory; it verifies the resulting credential file and atomically renames it with mode 0600. No supplied key enters argv or durable generic mutation receipts.

## Auth matrix and limits

| Boundary | Authentication | Validation and limits |
| --- | --- | --- |
| Existing Settings reads/actions | Existing gateway owner/runtime auth | Existing revision/idempotency/body limits |
| Workflow capabilities/status | Verified gateway principal matching the configured runtime owner | Fixed harness/operation IDs, bounded expiring operations, no public endpoints |
| Login/install/cancel/uninstall | Owner writable capability | bodyLimit before buffering, fixed commands/managed prefix, deadline/reaping, operation identity |
| Key validate/save | Owner writable credential capability | Separate bounded secret payload, provider allowlist, timeout, safe errors and atomic preservation |
| Usage history | Existing platform Clerk owner auth | Resolve active owner computer from runtime slot; bounded cursor/page, Kysely owner+machine+slot predicate |
| Logs | Owner runtime/exact operation | Bounded redacted projection; no filesystem paths, raw errors or credentials |

GET responses are private/no-store. New DELETE endpoints are mutations and require bodyLimit. All external calls have timeouts. Server-generated URLs and command targets are allowlisted; no user-controlled destinations. In-memory registries have cap/TTL and shutdown cleanup. Cancellation and scope changes reject late completion; a failed cancellation cannot appear successful.

## Validation and delivery

Tests first for grouped semantic state, native login/key failures, cancellation/retry, safe uninstall, owner/runtime switches, dependency preservation, compatibility, pagination/redaction and renderer wiring. Run focused tests and typechecks, pattern checks, canonical production shell and Electron builds. Backend changes require a matching immutable Preview VPS and Electron Desktop; frontend-only acceptance still requires Electron Desktop. Record exact client and backend heads and demonstrate fresh/reopened Chat, reload/presentation switches and Settings workflows.

Deliver three English implementation PRs stacked as backend/contracts, shared workflow components/transports, and grouped UI/acceptance, each linked to the primary issue. This keeps each review layer within the repository size limits. Deploy the top layer for complete exact-head acceptance, plus an isolated Preview Platform revision for ledger history. Deliver a separate public documentation PR in FinnaAI/matrix-os-site/content/docs. Public docs contain no private account/runtime identifiers. Stop at a runnable Human Review environment; request Greptile only after user approval. No production/fleet deployment, channel promotion, payment or primary-computer credential mutation is part of acceptance.

## Discovery record

Native adapter details are established with bounded disposable spikes and tests before committing to their final contract. Record unavailable native capabilities explicitly and return any material visible scope change for review. Never ship fabricated state or hide an unmet designed workflow.

The actual Codex CLI 0.153.4 isolated-save spike confirmed `login --with-api-key` plus file credential storage writes the synthetic key in `auth_mode: apikey`, without a token object. The temporary directory was removed. This verifies native file format and save behavior; it is separate from valid live-key or subscription acceptance.

## Authenticated workflow denial

### 1. Scope / Trigger

An authenticated Preview collaborator can enter a runtime without owning its native provider credentials. Capability discovery must not terminate that valid Matrix session when owner permission is missing.

### 2. Signatures

All `/api/ai/provider-settings/workflows` capabilities, status, logs, start, key and cancel routes use `getPrincipal(context): { userId: string } | null` plus the configured service `ownerId`.

### 3. Contracts

Missing principal returns HTTP401 with safe `unauthorized`; a valid principal whose `userId` differs from `ownerId` returns HTTP403 with safe `forbidden`. The owner-only boundary applies before adapters, operation receipts or native credentials are accessed. HTTP403 must not invoke Electron `auth:session-expired`; capability discovery may fall back to the existing supported Settings controls. No database, credential or environment identity is rewritten to impersonate the owner.

### 4. Validation & Error Matrix

| Principal | Runtime owner match | Outcome |
| --- | --- | --- |
| Missing/invalid | N/A | 401; reauthentication required |
| Valid | No | 403; session retained, no adapter/native action |
| Valid | Yes | Existing validated workflow behavior |

### 5. Good/Base/Bad Cases

Good: owner capability lookup continues normally. Base: signed collaborator receives403 and can continue using permitted runtime features. Bad: returning401 for that collaborator signs the user out even though authentication succeeded.

### 6. Tests Required

Exercise real auth middleware, request principal and workflow registration for signed owner, signed collaborator and absent authentication. Assert all workflow endpoints deny the collaborator with403 and zero adapter calls. Assert missing authentication remains401. Cover the renderer API response boundary so403 does not invoke session expiry and401 does.

### 7. Wrong vs Correct

Wrong: `if (actor !== owner) throw new ProviderWorkflowError('unauthorized')` (HTTP401). Correct: distinguish authenticated `forbidden` (HTTP403) from a missing principal (HTTP401), retaining owner-only credential access.

## Capability-unavailable and enablement repair

### 1. Scope / Trigger

A valid runtime session can lack guided credential-workflow permissions. The
compact approved connection presentation must survive that failure. An installed
Hermes with no eligible account cannot switch the system runtime through Enable.

### 2. Signatures

`providerEnablementBlockReason(harness, sources, now): string | null` derives
canonical prerequisites. Workflow transports distinguish `forbidden` from
`unavailable` without exposing raw response messages. Settings setup catalog
reads explicitly negotiate `includeSettingsSetupActions=true` to retain original
server-issued setup commands for disabled executable harnesses; ordinary Chat
catalog reads keep those commands absent. The flag is a bounded boolean query
parameter and duplicate values are rejected.

### 3. Contracts

Catalog-only rows use presentation IDs only; install/connect handoff uses the
authoritative catalog entry and advertised action. Guided credential writes stay
owner-only. Legacy configuration remains a secondary disclosure, including when
capabilities are unavailable. Figma SVG assets are stored unchanged; the designed
OC/Pi/H/Cl marks are Settings-specific text layers.

### 4. Validation & Error Matrix

Do not allow On for uninstalled or unsupported credential routes. Preserve Off
even if credentials disappear. Native Claude/Codex preferences keep their existing
contract. Exact saved Hermes source-null payload is schema-valid; the route maps
the store's invalid route to the safe public `invalid_request` HTTP 400.


| State | Presentation / mutation |
| --- | --- |
| Owner workflow denial | Valid session retained; unavailable methods explained |
| Missing guided capabilities | Compact chooser and catalog remain visible |
| Hermes account missing | Connect-first hint; On disabled; no invalid mutation |
| Mutation rejected | Confirmed route, revision and selected agent retained |

### 5. Good/Base/Bad Cases

Good: an authorized Terminal setup action remains available while its agent is
Off. Base: capability denial retains the compact chooser and a safe permission
explanation. Bad: missing credentials submit an invalid enable mutation, or a
workflow failure exposes the full legacy editor as the default connection UI.

### 6. Tests Required

Red/green regressions cover capability-unavailable Codex chooser, missing OpenClaw
catalog row, source-null Hermes enable prerequisite, typed workflow denial and
failed-save retention/retry. Real route/store regression asserts public HTTP 400
and zero runtime changes for the captured payload.

### 7. Wrong vs Correct

Correct: display Connect Codex choices with an explicit unavailable method and a
real advertised Terminal action. Incorrect: expose the legacy editor by default
or manufacture a workflow operation ID. Correct: explain Hermes's connection
prerequisite. Incorrect: change backend authorization or label an unconfigured
agent connected to make Enable succeed.
