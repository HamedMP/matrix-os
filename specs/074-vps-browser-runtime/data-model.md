# Data Model: VPS Browser Runtime

## Ownership Model

All entities are scoped to an owner principal. v1 uses personal owner scope. Organization policy can extend the same shape later by adding an org owner kind and RBAC checks.

Structured records live in owner-controlled Postgres via Kysely. Chromium profile payloads, staged downloads, completed downloads, screenshots, thumbnails, and lock files live in owner-scoped filesystem paths under the Matrix home.

## Entities

### BrowserProfile

Represents a persisted Chromium profile for one owner.

Fields:
- `id`: stable profile id
- `ownerId`: Matrix owner principal
- `name`: profile slug; v1 default is `default`
- `displayName`: user-visible label
- `profilePath`: owner-scoped filesystem path to Chromium profile
- `state`: `available` | `locked` | `clearing` | `corrupt` | `deleted`
- `activeSessionId`: nullable reference to the live runtime session
- `lockOwner`: nullable runtime/device id currently holding the profile lock
- `lockDeviceId`: nullable physical device id currently allowed to write to the live profile
- `lockExpiresAt`: nullable timestamp for stale-lock recovery
- `createdAt`, `updatedAt`, `deletedAt`

Validation:
- Profile names match lowercase slug rules (`^[a-z][a-z0-9_-]{0,62}$`).
- Profile paths must resolve within the owner Matrix home.
- v1 allows only `default` unless a later profile-management feature enables named profiles.

State transitions:
- `available -> locked`: runtime session starts.
- `locked -> available`: runtime session closes cleanly.
- `locked -> available`: stale lock expires and recovery succeeds.
- `available|locked -> clearing`: user confirms clear; active session is closed first.
- `clearing -> available`: selected clear scopes finish.
- `any -> corrupt`: profile open or validation fails in a way requiring recovery.
- `any -> deleted`: owner deletes profile data.

### BrowserSession

Represents a resumable browser runtime session for one profile.

Fields:
- `id`: stable session id
- `ownerId`
- `profileId`
- `runtimeId`: current VPS-local runtime process id, nullable when recoverable
- `deviceId`: client device that owns the live runtime lock
- `focusSurfaceId`: nullable stream/surface id currently holding the input focus lease
- `protocolVersion`: negotiated Browser stream/control protocol version
- `mediaMode`: `webrtc` | `fallback_frame`
- `state`: `starting` | `active` | `idle_hibernated` | `closing` | `closed` | `recoverable` | `failed`
- `currentTabId`: nullable active tab
- `surfaceCount`: active Canvas/standalone stream count
- `lastActiveAt`
- `idleDeadlineAt`
- `createdAt`, `updatedAt`, `closedAt`
- `failureCategory`: nullable bounded category

Validation:
- At most one live `active` or `starting` session per `BrowserProfile`.
- Second same-device surface may attach to the same session.
- Second physical device must enter `recoverable` conflict flow until user chooses wait or take over.
- At most one attached surface holds the focus lease. Pointer, wheel, keyboard, IME, and paste input from non-focused surfaces is rejected.

State transitions:
- `starting -> active`: runtime started and stream-ready.
- `starting -> failed`: runtime failed before usable state.
- `active -> idle_hibernated`: idle timeout reached; browser process closed, durable profile retained.
- `active -> closing -> closed`: user closes session.
- `active -> recoverable`: gateway/browser service restarts or stream disconnects unexpectedly.
- `recoverable -> starting`: user resumes session.
- `active -> failed`: unrecoverable runtime error.

### BrowserTab

Represents a tab/page within a Browser session.

Fields:
- `id`
- `ownerId`
- `sessionId`
- `profileId`
- `index`: tab order
- `title`: bounded display title
- `currentUrl`: normalized URL or redacted unavailable marker
- `faviconUrl`: optional public URL, bounded. Runtime MUST validate favicons with the same public-address URL policy used for navigation before storing or emitting; invalid, private, loopback, link-local, Matrix-control-plane, or otherwise blocked favicon URLs are stripped and clients render a safe placeholder.
- `state`: `new` | `loading` | `ready` | `blocked` | `crashed` | `closed`
- `blockedReason`: nullable bounded category
- `deferredFeature`: nullable requested deferred feature category
- `createdAt`, `updatedAt`, `closedAt`

Validation:
- URLs are normalized and server-validated before navigation.
- Titles and favicons are length-capped before storage.
- Tab count is capped per owner/session.

State transitions:
- `new -> loading -> ready`
- `loading -> blocked`: URL or redirect policy blocks navigation.
- `ready -> loading`: navigation/refresh.
- `any -> crashed`: page/runtime crash.
- `any -> closed`: user closes tab or session closes.

### BrowserStream

Represents a live viewport/input connection from a Matrix UI surface to a Browser session.

Fields:
- `id`
- `ownerId`
- `sessionId`
- `surface`: `canvas` | `standalone`
- `surfaceId`: stable id for this attached UI surface
- `deviceId`
- `protocolVersion`
- `mediaMode`: `webrtc` | `fallback_frame`
- `mediaMuted`: boolean
- `iceTransportPolicy`: `relay`
- `turnCredentialExpiresAt`: nullable timestamp for the active relay credential
- `focusState`: `focused` | `background`
- `state`: `connecting` | `active` | `stale` | `closed`
- `lastTouchedAt`
- `connectedAt`
- `closedAt`

Runtime-only data:
- WebSocket handle
- bounded frame queue
- bounded input queue
- WebRTC peer connection/signaling state
- relay-only ICE candidate state
- resize/focus state

Validation:
- Stream token must be short-lived, signed, same-origin, and bound to owner/session/profile/surface/device.
- Stream protocol version must be compatible before the stream becomes active.
- WebRTC streams use relay-only ICE; local/private/loopback candidates are rejected before storage or forwarding.
- Stream registries are capped and sweep stale connections.
- Only the focused surface may submit browser input; focus changes are broadcast to every stream.

State transitions:
- `connecting -> active`
- `active -> stale`: missed heartbeat or network partition.
- `stale -> closed`: stale sweep evicts.
- `active -> closed`: normal close.

### BrowserDownload

Represents a file downloaded by a Browser tab.

Fields:
- `id`
- `ownerId`
- `sessionId`
- `tabId`
- `sourceUrl`: bounded normalized URL or redacted public target
- `suggestedFilename`: sanitized display filename
- `stagingPath`: runtime-private owner-scoped path
- `finalPath`: nullable Matrix files/download path after completion
- `mimeType`: optional bounded value
- `sizeBytes`: nullable until complete
- `state`: `staging` | `complete` | `failed` | `deleted`
- `failureCategory`: nullable bounded category
- `createdAt`, `completedAt`, `deletedAt`

Validation:
- File names are sanitized and resolved within owner downloads root.
- Partial files never appear through Matrix file APIs.
- Completed file publish is atomic rename/move from staging to final path.

State transitions:
- `staging -> complete`: download finishes and file is atomically published.
- `staging -> failed`: session close, network failure, size cap, policy block.
- `complete -> deleted`: owner deletes file.
- `failed -> deleted`: cleanup removes partial.

### BrowserPermissionGrant

Represents explicit user permission for an app or agent to inspect or control Browser.

Fields:
- `id`
- `ownerId`
- `requesterType`: `agent` | `app`
- `requesterId`
- `profileId`
- `scope`: `read_dom` | `screenshot` | `download` | `navigate` | `automate_input`
- `domainSet`: allowed hostname/domain patterns
- `expiresAt`
- `expiresReason`: `matrix_session` | `duration` | `explicit`
- `revokedAt`
- `createdAt`

Validation:
- Default expiry is the earlier of the bound Matrix web session expiry or 8 hours from grant creation unless the user chooses a shorter duration.
- Domain set must be explicit and bounded.
- Grants are checked on every agent/app action; no restart required after revocation.

State transitions:
- `active -> expired`
- `active -> revoked`

### BrowserAuditEvent

Owner-visible record for security-sensitive Browser events.

Fields:
- `id`
- `ownerId`
- `profileId`: nullable
- `sessionId`: nullable
- `tabId`: nullable
- `eventType`: bounded enum
- `category`: optional bounded category
- `targetUrl`: optional redacted/normalized target URL
- `requesterId`: optional app/agent id
- `createdAt`
- `metadata`: bounded JSON with redacted values only

Event types:
- `session.created`
- `session.closed`
- `session.idle_hibernated`
- `session.taken_over`
- `navigation.attempted`
- `navigation.blocked`
- `download.started`
- `download.completed`
- `download.failed`
- `download.deleted`
- `profile.cleared`
- `permission.granted`
- `permission.revoked`
- `agent.access`

Validation:
- No cookies, auth headers, password fields, page HTML, screenshots, raw stack traces, or unbounded URLs.
- Audit metadata is size-capped.
- Default retention is 180 days unless the owner chooses a shorter retention policy; owner export/delete flows apply before pruning.

### BrowserRuntimeHealth

Runtime-only computed aggregate; not persisted to Postgres and not exported as owner data. Coarse runtime readiness state surfaced to UI and platform health.

Fields:
- `capabilityAvailable`: boolean
- `chromiumAvailable`: boolean
- `profileRootWritable`: boolean
- `activeSessionCount`: bounded number
- `capacityState`: `ok` | `limited` | `full` | `unavailable`
- `lastCheckedAt`

Validation:
- Client-visible health exposes coarse booleans/states only, not internal paths or package/provider errors.

## Relationships

- One owner has one or more `BrowserProfile` records; v1 enables only one default profile.
- One `BrowserProfile` has many historical `BrowserSession` records but at most one live session.
- One `BrowserSession` has many `BrowserTab`, `BrowserStream`, `BrowserDownload`, and `BrowserAuditEvent` records.
- `BrowserPermissionGrant` is scoped to owner, requester, profile, scope, domain set, and expiry.
- `BrowserDownload.finalPath` is linked to Matrix file surfaces after completion.

## Cleanup Policies

- Idle sessions close/hibernate at default 15 minutes unless policy changes.
- Stale streams are swept by `lastTouchedAt`.
- Failed/partial downloads are cleaned from staging by TTL and max-count sweeps.
- Screenshots/thumbnails/crash artifacts use symlink-safe recurring cleanup with `lstat` and skip symlinks.
- Expired grants remain queryable for audit until the associated audit retention window expires, default 180 days unless the owner chooses a shorter policy, then are pruned according to owner policy.
