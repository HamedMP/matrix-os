# Research: Hermes Manager

## Decision: Build a Matrix-native manager rather than iframe the Hermes dashboard

**Rationale**: Matrix OS needs owner-scoped auth, redacted credential handling, Canvas/Desktop consistency, app packaging, and channel/session controls that fit the OS shell. The upstream Hermes dashboard remains useful as a reference but should not be the everyday product surface.

**Alternatives considered**:

- Iframe the Hermes dashboard: rejected because auth, secret redaction, app permissions, and Matrix shell integration would be weak.
- Copy Hermes internals into Matrix: rejected because Hermes should stay the source of truth for its own IPC/CLI/API behavior.

## Decision: Add a dedicated gateway subsystem under `/api/hermes`

**Rationale**: Symphony already shows the right Matrix-native pattern: typed contracts, route-level auth, owner-scoped repositories, redacted credential stores, and optional event streams. Hermes needs similar isolation and reviewability because it touches secrets, messaging channels, process lifecycle, and AI sessions.

**Alternatives considered**:

- Put all logic in the app using app bridge calls: rejected because secrets and Hermes process control must stay server-side.
- Add generic `/api/bridge/service` calls only: rejected because Hermes needs first-party auth, validation, body limits, and redaction guarantees.

## Decision: Use Hermes CLI/local API/WebSocket surfaces through a typed bridge

**Rationale**: The pulled Hermes repo exposes CLI setup/config/model/gateway flows, FastAPI dashboard endpoints, and a WebSocket/TUI JSON-RPC path for sessions. A `HermesBridge` interface lets Matrix mock and test those surfaces while keeping upstream Hermes behavior authoritative.

**Alternatives considered**:

- Shell directly from every route: rejected because route code would duplicate timeout, error, redaction, and concurrency handling.
- Depend only on Hermes dashboard HTTP endpoints: rejected because some session/IPC operations are already modeled through the TUI gateway/WebSocket protocol.

## Decision: Telegram and WhatsApp are P1 channel operations

**Rationale**: The user explicitly narrowed earlier messaging work toward WhatsApp and Telegram first, and Hermes gateway configuration supports both. Other providers should be visible if discovered but should not block the first implementation.

**Alternatives considered**:

- Implement all Hermes-supported channels at once: rejected as oversized for one stack and harder to test to PR-ready quality.
- Build Matrix protocol bridge first: rejected because the user asked for Hermes as orchestrator across channels, with Telegram/WhatsApp first.

## Decision: Owner Postgres for structured runtime state, owner files for redacted config/export snapshots

**Rationale**: Matrix OS requires Kysely/Postgres for new structured persistence. Owner-controlled files remain appropriate for inspectable identity/config/export state. The design uses repository abstraction so local tests can run against in-memory fakes while production uses existing gateway storage.

**Alternatives considered**:

- Add SQLite or another embedded database: rejected by the Matrix OS constitution.
- Store everything in JSON files: rejected for sessions/events/concurrency because structured records and locks need queryable state.

## Decision: EventSource for app status streams in the first slice

**Rationale**: Symphony already uses EventSource for dashboard refresh. Hermes session events can be represented as bounded server-side event streams in the gateway while route tests stay simple. Browser WebSocket support can be added later if Hermes session control needs bidirectional low-latency transport beyond prompt/approval POSTs.

**Alternatives considered**:

- Browser WebSocket first: deferred because it requires query-token auth allowlisting and a larger security surface.
- Polling only: rejected because streamed Hermes responses and tool activity are core UX.

## Decision: Concurrency locks per logical target

**Rationale**: Setup, pairing, restart, update, approval, and prompt-send actions need dedupe or rejection to avoid duplicate process calls and double approvals. A bounded in-memory lock map with TTL plus repository state prevents obvious duplicate actions in one gateway process; future multi-process support can move locks into Postgres.

**Alternatives considered**:

- Let Hermes handle all duplication: rejected because Matrix must provide clear operator feedback and cannot assume upstream idempotency for every action.
