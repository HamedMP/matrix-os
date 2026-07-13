# Integration Wiring

## Effective Read Path

```text
GET /api/settings/agent
  ├─ read identity + system/config.json once
  ├─ resolve kernel model/effort + credential precedence
  ├─ probe Hermes and OpenClaw adapters concurrently
  ├─ read active runtime provider/model through selected adapter
  ├─ normalize + cap provider catalogs
  └─ validate AgentSettingsViewSchema before response
```

The file read is authoritative for saved Chat settings and messaging runtime selection. Runtime probes are advisory health/config state. If either optional runtime is absent or malformed, its descriptor becomes unavailable; the route still returns Chat settings.

## Additive Settings Update

```text
PUT legacy { model, effort }
  validate kernel allowlists
  atomically patch kernel fields
  return full additive view

PUT extended { runtime, provider, messagingModel, baseUrl, revision }
  validate strict patch + current revision
  configure target adapter when requested
  run serialized runtime transition when runtime changes
  atomically persist selection/revision only after health
  return full additive view
```

No client sends the full object back. Omitted values are unchanged. Runtime configuration uses the target runtime's supported API before activation; a failed configure or health probe cannot update the active selection.

## Kernel Chat Message Path

```text
authenticated /ws frame
  WsMessageSchema { type: "message", text, ..., model?, effort? }
  -> server forwards a typed MessageDispatchOptions
  -> dispatcher validates against shared kernel allowlists
  -> KernelConfig { model, effort, ... }
  -> Claude Agent SDK V1 query()
```

All non-Chat dispatch callers omit message overrides and retain saved-file/default resolution. Request-scoped overrides are not queued as mutable global state.

## Conversation Transcript Path

Hono's exact route matching prevents `GET /api/conversations/:id` from matching the longer `/:id/search` sibling; registration order is not the safety mechanism. Tests exercise both paths so a future wildcard or mount change cannot silently shadow either route. The transcript route validates the id, calls the existing `conversations.get(id)`, maps only the true absent case to 404, and lets operational errors become safe 5xx responses. It never synthesizes a transcript from list metadata.

## System Information Path

`getSystemInfo(homePath)` uses the same pure kernel-config resolver as Agent settings and kernel options. The resolver returns the effective model: explicit `kernel.model`, then the current kernel default. `SystemInfo.model` is required for current gateways and safely optional for older clients.

## Hermes Adapter

- Reuse the existing validated loopback dashboard origin.
- Call status and model-info concurrently for the runtime descriptor.
- Normalize model options and auth flags into provider descriptors.
- Use the existing model-set operation for messaging provider/model updates.
- Keep `/api/hermes/*` unchanged for the detailed selected-runtime dashboard.
- Do not route Matrix Chat through Hermes.

## OpenClaw Adapter

- Connect to a fixed loopback WebSocket gateway with the owner-only token.
- Complete the documented authenticated connect handshake.
- Allowlist `health`, `config.get`, `config.patch`, `models.list`, `models.authStatus`, and `channels.status` only.
- Pair configuration writes with the latest config hash and serialize them.
- Debounce or coalesce compatible configuration patches and never issue more than 3 writes per rolling 60 seconds per device/IP; preserve the last confirmed selection when the bounded queue rejects excess work.
- Normalize configured/all model catalogs without returning OpenClaw schemas or raw errors.
- OpenClaw config/profile/state files remain runtime-owned.
- The official Matrix plugin is installed and allowlisted for future controlled integration, but direct Matrix ingestion stays disabled in V1.

## Runtime Process Wiring

```text
matrix-openclaw-gateway.service
  User=matrix
  EnvironmentFile=/opt/matrix/env/host.env
  ExecStart=/opt/matrix/bin/matrix-openclaw-gateway
  loopback + token auth
  Restart=on-failure with bounded restart policy

matrix-agent-runtime-control
  status
  switch hermes
  switch openclaw
```

The controller maps enum values to fixed units. Hermes dashboard may remain running as its settings API, but only the selected messaging delivery adapter receives Matrix work. OpenClaw gateway may remain stopped when unselected unless settings needs a bounded temporary start for configuration; that lifecycle is explicit and health-gated.

## Messaging Permission Adapter

Spec 077's Matrix-owned event consumer becomes runtime-neutral at the naming boundary while preserving its data and transactional rules:

```text
Matrix event -> permission/revision check -> work item -> selected runtime adapter
runtime output -> permission/revision recheck -> controlled Matrix send
```

Existing `HermesDeliveryRegistry` can be generalized in a dedicated PR, with compatibility exports during migration. Runtime switching pauses new claims from the work queue; it does not rewrite permission records or room mappings.

## Web Shell

- Remove only `agent` from `HIDDEN_SECTION_IDS`.
- Extract a typed `agent-config` client/normalizer from the existing identity/SOUL component.
- Render Canvas-first: current selection summary, messaging runtime picker, provider/auth cards, model/effort controls, messaging dashboard when supported, then identity/SOUL.
- Use `@matrix-os/brand` tokens/primitives for landing-adjacent setup/auth surfaces and existing shell components elsewhere.
- Open subscription login and installations in the canonical visible `__terminal__` built-in.
- Treat old gateways as a normal state: preserve identity/SOUL and legacy model/effort; show update-needed for extended cards.

## Desktop

- Extend the existing defensive normalizer with schema-safe optional extended fields.
- Preserve the current model/effort and SOUL behavior.
- Runtime/provider cards consume the gateway contract; privileged terminal/service actions go through trusted main/preload typed IPC.
- The renderer never embeds a raw setup command or credential in persistent state.

## Mobile

- No UI changes in this stack.
- `GET/PUT /api/settings/agent` remains compatible with the branch stack beginning at PR #941 and current PR #955.
- Extended schemas are exported from `@matrix-os/contracts` for incremental adoption.
- Conversation transcript and system-info model gaps land independently so mobile session switching does not wait on the full runtime feature.

## Preview Deployment Wiring

- Confirm PR #919 preview points at the backend-stack tip containing #929–#935 before testing provider setup.
- Inspect deployed release metadata and exact bundle SHA; do not infer from PR labels alone.
- If the route-precedence fix is missing, deploy the exact backend-stack tip through the preview host-bundle path.
- Verify `POST /api/terminal/sessions {name,cwd,cmd}` through authenticated routing, then observe the canonical Terminal tab connect and visible install/login command.
- For each feature PR, build/publish an immutable host bundle, deploy exact version to a `preview-vps`, verify installed `BUNDLE_VERSION` and `release.json`, service health, API contract, web Canvas, desktop fallback as feasible, and OpenClaw absent/healthy switch cases.
