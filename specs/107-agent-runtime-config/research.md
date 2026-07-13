# Research: Unified Agent Runtime Configuration

## Decision: Preserve Two Distinct Agent Layers

**Decision**: Matrix OS Chat remains the Claude Agent SDK V1 kernel. The `hermes | openclaw` runtime selection controls only the optional messaging-agent adapter.

**Rationale**: The current gateway boots the kernel without a model override, so owner `system/config.json` is authoritative for Chat. Hermes dashboard APIs configure a different external process. OpenClaw is likewise an external gateway. Replacing Chat with either runtime would break the constitution's kernel invariant and existing shell/mobile behavior.

**Alternatives considered**:

- Replace the kernel with the selected runtime: rejected because the runtimes have incompatible session, tool, prompt, permission, and persistence models.
- Present both layers under one ambiguous “Hermes” label: rejected because it makes configuration and failures unsafe to reason about.
- Keep separate product pages with no unified view: rejected because owners need one coherent effective-state surface.

## Completed OpenClaw Spike

### Tested artifact

- Package: `openclaw@2026.6.11`, the current stable npm release on 2026-07-13.
- Host: Node.js 24.14.1, pnpm 10.33.4.
- Throwaway install root and state directory under `/tmp`; both removed after the spike.
- CLI reported `OpenClaw 2026.6.11 (e085fa1)`.

### Process and network model

**Decision**: Run one owner-scoped OpenClaw gateway as a systemd service bound to loopback with token authentication.

**Evidence**:

- The gateway rejected `--auth none` and exited with code 78 even on loopback.
- With token authentication it listened on `127.0.0.1` and `::1` and served authenticated WebSocket RPC.
- It shut down cleanly on SIGINT in 19–34 ms.
- A Matrix-owned wrapper can set isolated `HOME`, state/config paths, port, and token without exposing them to shells.

**Alternatives considered**:

- Browser-to-OpenClaw connection: rejected; it would expose a loopback token and runtime-specific contract.
- Unauthenticated loopback: rejected by both OpenClaw and Matrix defense-in-depth requirements.
- Spawn per settings request: rejected due to startup cost and lifecycle races.

### Configuration and provider/model surface

**Decision**: Use authenticated RPC methods through an allowlisted adapter; do not edit OpenClaw files directly and do not expose generic RPC.

**Evidence**:

- `config.get` returned a redacted config plus revision hash.
- `config.patch`, `config.apply`, and `config.set` required the base hash and wrote the JSON configuration atomically with backup behavior.
- `models.list` supported configured/all views and returned a bounded-normalizable provider/model catalog.
- `models.authStatus` returned readiness without returning credential values.
- Setting `anthropic/claude-opus-4-6` persisted, hot-reloaded, and left the gateway healthy when authentication was missing; readiness correctly became action-required.
- Config writes are internally rate-limited to 3 per 60 seconds per device and IP, so Matrix must serialize and debounce its own writes too.

**Alternatives considered**:

- Write `openclaw.json` from Matrix: rejected because it bypasses hashing, validation, atomic backup, and hot reload.
- Proxy arbitrary config/schema RPC: rejected because it expands the attack surface and may reveal plugin/provider internals.

### Authentication flows

**Decision**: Normalize platform, API-key, OAuth/subscription-login, and custom-base-url capabilities into Matrix provider descriptors. Credentials remain in the owning runtime or trusted kernel configuration.

**Evidence**:

- OpenClaw supports API keys, interactive/OAuth login, and reuse of supported CLI login credentials through its own auth-profile store.
- `models.authStatus` is sufficient for coarse readiness.
- The OpenClaw agent state observed in the spike is runtime-owned; Matrix must not read its SQLite internals or expose profile data.

**Alternatives considered**:

- Import credentials into Matrix client state: rejected; clients must never persist provider secrets.
- Parse runtime auth files: rejected; formats are private and may contain credentials.

### Matrix channel and permission parity

**Decision**: Do not make OpenClaw a direct Matrix-room member in the first release. Keep Matrix OS as the permission-gated event consumer and controlled reply sender defined by spec 077.

**Evidence**:

- Matrix support was not in the core package. Installing official `@openclaw/matrix@2026.6.11` added a Matrix channel with room/user allowlists, E2EE and group policies.
- The plugin could load and report `configured: false`, `running: false`, `not configured` while the gateway remained healthy.
- OpenClaw's allowlists are useful defense-in-depth but cannot replace Matrix OS permission revisions, revocation cancellation, audit, and replay rules.

**Alternatives considered**:

- Direct OpenClaw Matrix login: deferred because membership, E2EE keys, room history, and revocation could outlive Matrix OS permission.
- Treat plugin allowlists as permission parity: rejected because they are a second policy source and lack spec 077 transactional revocation semantics.

### Footprint and minimum resource policy

**Decision**: OpenClaw is optional and disabled on resource-constrained computers until an admission check passes.

**Evidence**:

- Installed core dependency footprint: approximately 346 MiB.
- Owner state including the Matrix plugin: approximately 47 MiB after the spike.
- Resident memory: approximately 344 MiB with the constrained plugin set; approximately 600 MiB with the default plugin set.
- Explicit `plugins.allow` reduces loaded surface, but essential model-provider and memory plugins may still auto-enable.

**Admission baseline**: Preserve spec 077's messaging floor of 2 vCPU, 4 GiB RAM, 40 GiB disk. Require at least 768 MiB available memory and 1 GiB free disk before installation/activation. Re-check exact production usage on preview before stable promotion.

## Decision: Additive Agent Settings Contract

**Decision**: Keep legacy `identity`, `kernel`, `availableModels`, `availableEfforts`, and `defaults` fields. Add `contractVersion`, `revision`, `chat`, `runtime`, `providers`, and `currentSelection`.

**Rationale**: Desktop and mobile already rely on the legacy shape. Strict replacement would break rolling upgrades. A versioned additive view lets current shells adopt runtime/provider cards while old clients continue model/effort operations.

**Alternatives considered**:

- New unrelated endpoint: rejected because it leaves two sources of truth and complicates mobile adoption.
- Replace legacy fields: rejected due to shipped clients.
- Duplicate provider catalogs per shell: rejected because availability/auth are computer state.

## Decision: Provider Descriptors Are Scoped

**Decision**: Every provider descriptor identifies whether it applies to `chat`, `messaging`, or both. It exposes one effective/recommended `authKind` plus a bounded `supportedAuthKinds` list because a provider may offer platform access, BYOK, and subscription login at the same time. The first Chat catalog is Anthropic-only; Hermes/OpenClaw may expose multiple messaging providers.

**Rationale**: A single flat provider choice would imply that the Claude SDK kernel can use any external runtime provider, which is false today. Scope makes current capabilities accurate and allows future kernel routing without contract replacement.

## Decision: Settings Writes Use Field Presence and Revisions

**Decision**: Optional update fields have patch semantics: omitted means unchanged. Extended clients send a revision for runtime/provider changes; stale revisions return a safe conflict. Legacy model/effort-only writes remain accepted and atomically merge into the current file.

**Rationale**: Older mobile clients send only two fields. Requiring extended fields would break them, while whole-object replacement would erase new selections. Runtime switches need stronger concurrency than last-write-wins.

## Decision: Runtime Process Control Uses a Narrow Controller

**Decision**: A host wrapper accepts only `status`, `switch hermes`, or `switch openclaw`, uses fixed unit names, an exclusive lock, bounded service waits, and JSON output. Gateway never passes arbitrary unit names or shell fragments.

**Rationale**: systemd controls process ownership, restart, and shutdown on customer VPSes. A narrow wrapper is testable and prevents runtime identifiers from becoming command injection or arbitrary service control.

## Decision: Reuse Existing Hermes Dashboard Without Generic Proxy Expansion

**Decision**: The Hermes adapter calls the existing allowlisted `/api/hermes` service helper or its internal typed equivalent. Existing `/api/hermes/*` remains compatible for the dashboard. The unified settings route returns only normalized subsets.

**Rationale**: Spec 101 already established loopback, timeouts, redaction, and safe errors. Reimplementing or directly parsing Hermes files would create a second unsafe path.

## Decision: UI Is Guided, Not Raw Configuration

**Decision**: Agent settings uses a runtime summary, provider cards, model/effort controls, visible authentication actions, health/empty/error states, and an advanced messaging dashboard only when the selected runtime supports it. No raw config editor ships in the first release.

**Rationale**: Raw runtime config contains unstable keys and secret-adjacent data. Guided controls make the common owner task clear and keep runtime details behind typed contracts.

## Source Links

- OpenClaw gateway configuration: https://docs.openclaw.ai/gateway/configuration
- OpenClaw gateway operation: https://docs.openclaw.ai/gateway
- OpenClaw model CLI and authentication: https://docs.openclaw.ai/cli/models
- OpenClaw gateway authentication: https://docs.openclaw.ai/gateway/authentication
- OpenClaw Matrix channel: https://docs.openclaw.ai/channels/matrix
- OpenClaw getting started: https://docs.openclaw.ai/start/getting-started
- Hermes dashboard: https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard
- Hermes providers: https://hermes-agent.nousresearch.com/docs/integrations/providers
- Hermes Matrix messaging: https://hermes-agent.nousresearch.com/docs/user-guide/messaging/matrix
- Matrix OS messaging permission architecture: [spec 077](../077-matrix-messaging-bridge/spec.md)
