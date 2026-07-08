# Coding Agent Shells

This guide documents the Matrix OS coding-agent shell architecture for gateway, desktop, mobile, and browser shell work. The gateway/runtime remains the source of truth; clients are resumable shells that render validated summaries and snapshots.

## Ownership Boundaries

- Shared contracts live in `packages/contracts/src/index.ts` and are the only supported cross-shell shape for runtime summaries, providers, threads, events, approvals, terminal summaries, review snapshots, file reads, and preview summaries.
- Gateway owns coding-agent read models, provider adapters, thread state, event replay, approval decisions, input answers, terminal binding, review/file adapters, preview summaries, and safe error mapping.
- Desktop main process owns bearer-authenticated gateway calls. Renderer code receives only Zod-validated, bounded data over typed IPC and must not receive bearer tokens or provider credentials.
- Mobile uses the authenticated `GatewayClient` and may persist only bounded UI references such as selected IDs and timestamps. Do not persist transcripts, terminal output, file contents, diffs, raw approval payloads, credentials, or launch tokens.
- Browser shell surfaces call authenticated gateway routes and validate shared contracts before rendering. Shell-only filtering is defensive; project and owner scoping must happen in the gateway before list bounds are applied.
- Canonical terminals remain the existing Matrix terminal/session primitives under `/api/terminal/sessions`, `/ws/terminal`, and related compatibility routes. Do not create a separate coding-agent terminal model.

## Gateway Routes

The coding-agent route module is `packages/gateway/src/coding-agents/routes.ts`, mounted under `/api/coding-agents`.

- `GET /summary` returns `RuntimeSummarySchema` and accepts an optional validated `projectId` query for project-scoped preview summaries.
- `POST /threads` creates or returns an idempotent thread by `clientRequestId`.
- `GET /threads`, `GET /threads/:threadId`, and `GET /threads/:threadId/events` return bounded summaries or snapshots.
- `POST /threads/:threadId/abort` aborts idempotently.
- `POST /threads/:threadId/approvals/:approvalId/decision` records an idempotent approval decision.
- `POST /threads/:threadId/inputs/:inputRequestId/answer` records a bounded user-input answer.
- `GET /reviews` and `GET /reviews/:reviewId` expose bounded review summaries and snapshots.
- `GET /files/read` exposes bounded owner-worktree text snapshots.
- `GET /notification-preferences` returns coding-agent notification preferences for the authenticated owner.
- `PUT /notification-preferences` updates coding-agent notification preferences for the authenticated owner with a small body limit and atomic per-owner file persistence.

Every mutating route needs auth, `bodyLimit`, Zod validation, an ownership check, safe error mapping, and focused tests.

## Event Model

Thread events are validated by `AgentThreadEventSchema`. Reducers should treat the union as append-only input:

- Ignore unknown future event types instead of crashing.
- Use `event.id` for idempotency when replay and live stream overlap.
- Keep transcript rendering bounded in the client. Long-lived event history belongs in gateway-owned thread state, not in shell persistence.
- Render approval, input, file-change, review-ready, terminal-bound, safe-error, and completion events from their typed payloads only.

When adding an event type:

1. Add the schema to `AgentThreadEventSchema` with bounded payload fields.
2. Add contract tests for valid and invalid payloads.
3. Teach `thread-store` replay/summary derivation how the event affects status, attention, and terminal binding.
4. Update desktop/mobile reducers to ignore or render the new event without breaking older snapshots.
5. Add stream replay tests that prove replay plus live delivery remains idempotent.

## Provider Adapters

Provider-specific behavior belongs behind the gateway provider adapter interface, not in desktop or mobile UI. A provider adapter should:

- Normalize start, abort, status, tool activity, approvals, input requests, and completion into shared thread events.
- Enforce timeouts or `AbortSignal` on external calls.
- Return generic client errors while logging provider details server-side only.
- Use foreground terminal setup actions when user interaction is required.
- Avoid provider-specific branches in shell components unless the shared contract explicitly exposes safe metadata.

When adding a provider:

1. Add a provider summary state through the provider registry.
2. Add safe setup actions and health behavior with capped TTL cache state.
3. Add a provider adapter test using the fake or deterministic workspace path first.
4. Add thread-create tests for success, missing auth/setup, abort, failure, and safe error mapping.
5. Keep the provider behind a feature flag until end-to-end shell validation passes.

## Terminal Binding

Coding-agent threads may point at a canonical terminal session using bounded terminal identifiers. The binding rules are:

- Thread snapshots can expose attachable terminal references, not raw PTY output.
- Desktop should open the existing Terminal tab/model for a bound session.
- Mobile should hand off to the existing Terminal route/client and preserve the existing Terminal tab.
- Detach must not end the underlying process.
- Stale or ended terminal references should render recoverable UI and refresh summary state.

Do not store terminal output in mobile AsyncStorage or desktop renderer persistence.

## Approval And Input Flow

Approval and input requests are gateway-owned lifecycle events.

- The provider emits an approval or input event with bounded preview text.
- Desktop/mobile render the request from the thread snapshot or stream.
- Mobile thread details pin the newest unresolved approval or input request above the timeline while keeping the timeline as the audit trail.
- A shell submits a decision or answer with a bounded `clientRequestId`.
- Gateway applies the first valid decision idempotently, appends the resolution event, and broadcasts it.
- Other shells update from the returned snapshot or stream event.

Client UI must disable duplicate submission while a decision is in flight and recover by rehydrating the thread snapshot on failure. User-facing errors should be generic and recovery-oriented.

Mobile thread detail should rehydrate its current bounded thread snapshot when the app returns to the foreground so pending approval and input state reconciles with decisions made from other shells. This refresh must use the authenticated gateway client and must not persist approval payloads, input text, transcripts, or terminal output.

Mobile approval and input action handling lives in `apps/mobile/lib/agent-thread-actions.ts`. Keep the route responsible for hydration, streaming, navigation, and render composition; keep transient pending action ids, bounded action errors, input drafts, idempotency request ids, and accepted-snapshot haptic guards inside that hook. The hook must only act on the current route thread id, and success haptics must wait until the gateway-returned bounded snapshot has been accepted by the route.

Desktop thread timelines may group `assistant.text.delta` and `assistant.text.completed` events by bounded `messageId`, plus `tool.started`, `tool.output`, and `tool.completed` events by bounded `toolCallId`, for readability. Grouped rows must render only safe counts, display metadata, output presence/truncation, and completion state; never render raw assistant text, raw tool output, message ids, or tool call ids.

Mobile thread timelines may group `assistant.text.delta` and `assistant.text.completed` events by bounded `messageId` for readability. Grouped rows may render a capped assistant text preview only when the joined deltas pass local safe-display filtering; otherwise they must fall back to update counts and completion state. Never render message ids or sensitive-looking assistant text.

Mobile thread timelines may group `tool.started`, `tool.output`, and `tool.completed` events by `toolCallId` for readability. Grouped rows must render only safe tool display metadata, coarse output presence/truncation, and completion outcome; never render raw tool output text.

Desktop thread streams are owned by the trusted main process. The renderer asks
for `runtime:subscribe-thread-events`, receives only validated
`runtime:thread-event` payloads, and never receives bearer credentials or WS
tokens. Runtime switches and window shutdown must close active desktop stream
subscriptions.

## Attention Notifications

Coding-agent attention notifications are gateway-owned. Thread events for approval requests, user-input requests, failed runs, and successful completion may emit safe push-channel payloads with generic copy plus a bounded thread id. The bridge deduplicates owner/thread/kind notifications in a capped TTL registry and checks owner notification preferences before sending. Missing preferences, including legacy preference files without the completion key, default to enabled; corrupt or unavailable preferences must fail closed for push delivery and log details server-side only.

Push delivery is owner-scoped and cross-device by policy: a valid attention push fans out to the authenticated owner's active registered push tokens, not to other owners. The push adapter caps owner buckets and per-owner registered tokens, evicts only the oldest registrations for the same owner when that owner reaches the per-owner cap, drops stale token registrations before delivery, deduplicates token values, and caps per-notification fanout to the newest active devices so device growth cannot create an unbounded send batch.

Desktop and mobile may expose controls for approval, input, failed-run, and completion attention push preferences. Desktop must route reads and writes through trusted main-process IPC so bearer credentials stay out of the renderer. Mobile must use the authenticated gateway client and keep preference state transient; do not persist notification preference payloads in AsyncStorage. Preference updates are full replacements validated with `CodingAgentNotificationPreferencesUpdateSchema`.

Desktop badge counts may include `RuntimeSummary.attentionThreads.items.length` when the bounded list is complete. If `attentionThreads.hasMore` is true, the badge should use its overflow cap instead of guessing a total. The gateway summary remains the source of truth; do not mirror coding-agent attention state into a separate desktop-owned registry.

## Client State Rules

Desktop renderer stores may cache selected IDs, panel state, and validated summaries. They must not cache credentials, raw provider errors, terminal output, file contents beyond the current read-only render state, or unbounded transcripts.

Mobile state must stay smaller:

- Allowed: selected thread/review/preview/session IDs, route names, timestamps, small UI flags.
- Not allowed: transcripts, terminal output, file contents, diffs, raw approval payloads, provider credentials, launch tokens, internal paths, private hostnames.

Browser shell state follows the same UI-reference rule and must rehydrate from gateway state on project/runtime changes.

## Security Checklist

Use this checklist for every coding-agent shell PR:

- Shared contract boundary uses `zod/v4`.
- Route params, query params, request bodies, IPC payloads, WebSocket frames, and persisted client state are validated.
- Mutating HTTP routes use `bodyLimit`.
- Every external call has a timeout or `AbortSignal`.
- Every in-memory `Map` or `Set` has a cap and eviction policy.
- WebSocket auth completes before success frames, frame size is capped, subscribers are capped, stale subscribers are swept, and shutdown drains subscribers.
- Lists are bounded before response.
- Errors sent to clients are generic and safe.
- Desktop renderer never receives bearer credentials or provider credentials.
- Mobile AsyncStorage contains only bounded safe references.
- Terminal/session behavior reuses canonical Matrix terminal primitives.
- No new embedded persistence is introduced.

## Operator Runbook

Use this section when a coding-agent shell surface is enabled but a user cannot continue work from desktop or mobile. Keep support notes public-safe: do not paste customer identifiers, bearer tokens, provider credentials, private hostnames, VPS IPs, or raw provider output into GitHub, docs, or PR comments.

### Provider Setup Failure

Symptoms:

- The workspace shows a provider as missing, setup required, auth required, or unavailable.
- Starting a thread returns a generic setup or provider-unavailable message.
- The foreground setup terminal exits before the provider becomes available.

Checks:

1. Confirm the runtime summary is reachable through the authenticated gateway route and that `providers` contains the affected provider with a safe install/auth state.
2. Confirm the provider setup action opens a foreground terminal session instead of a hidden background job.
3. Confirm the user completed the provider's own CLI login flow inside the Matrix computer, not by pasting credentials into chat or docs.
4. Confirm the provider registry returns a generic client state while logging detailed setup failure server-side.
5. If the setup action repeatedly fails, leave the thread or provider in a recoverable setup-required state and record a follow-up with sanitized evidence.

Do not fix provider setup by moving credentials into desktop renderer state, mobile storage, shell query params, or PR comments.

### Runtime Offline Or Unavailable

Symptoms:

- Desktop or mobile shows an unavailable runtime summary.
- Thread, review, file, or preview panels show empty safe fallback states.
- A runtime switch leaves stale thread or terminal references visible.

Checks:

1. Verify the selected Matrix computer is the intended runtime before inspecting shell UI state.
2. Check the authenticated `/api/coding-agents/summary` path from the gateway side and confirm failures map to `SafeClientErrorSchema`.
3. Rehydrate the shell from gateway state after runtime switch; do not rely on persisted desktop/mobile references as source of truth.
4. Confirm stale thread, terminal, review, and preview references are dropped or rendered as recoverable.
5. Confirm user-visible messages do not include provider raw errors, stack traces, filesystem paths, private hostnames, VPS IPs, or database errors.

### Thread Or Event Stream Recovery

Symptoms:

- A thread detail opens but misses recent events.
- Mobile or desktop shows duplicated deltas after reconnect.
- Approval or input resolution appears stuck in one shell.

Checks:

1. Fetch the thread snapshot over HTTP first; the snapshot is the recovery path when a stream is stale.
2. Confirm replay cursors are bounded and the reducer deduplicates by event id.
3. Confirm desktop streams are opened by the main process through a short-lived WS token, while mobile streams use the authenticated gateway client.
4. Confirm the WebSocket authenticates before success, validates frame shapes, and reports a safe replay gap when history is no longer available.
5. Confirm approval and input decisions use bounded `clientRequestId` values and are idempotent.
6. If one shell stays stale, force a thread snapshot refresh before asking the user to repeat the action.

### Terminal Binding Recovery

Symptoms:

- A thread shows a terminal reference that no longer attaches.
- Mobile opens Terminal but the bound session is gone.
- Desktop and mobile disagree about whether a terminal is running.

Checks:

1. Treat the canonical terminal/session registry as source of truth.
2. If a bound session is missing or exited, render a recoverable stale state and refresh the runtime summary.
3. Do not create a coding-agent-only terminal model or duplicate terminal persistence.
4. Confirm detach does not terminate the process and terminate does update summaries.
5. Confirm mobile did not persist terminal output or replay buffers.

### Review, File, And Diff Recovery

Symptoms:

- A review snapshot is partial.
- A selected file cannot be opened.
- Large diffs are truncated or hunk lines are missing.

Checks:

1. Partial review snapshots are expected for large, binary, moved, unsafe, or unavailable files.
2. File reads must stay inside the validated owner worktree root and reject traversal and symlinks.
3. The UI should show changed-file metadata and recovery copy instead of raw paths or command output.
4. Follow-up prompts should carry structured references, not full file contents or unbounded diffs.
5. Mobile must reload file content from the gateway and must not persist file bytes.

### Preview Recovery

Symptoms:

- A preview row appears without an open action.
- A preview from another project appears missing.
- Opening a preview fails after a runtime or project switch.

Checks:

1. Project-scoped preview requests should be filtered before gateway list bounds are applied.
2. HTTPS origins may open directly; local HTTP origins should remain status-only unless the shell can safely attach to the local runtime.
3. Preview summaries must not include paths, query strings, tokens, internal hostnames, or provider logs.
4. Runtime or project switches should clear stale preview rows before new data loads.
5. If a preview is stale, refresh the runtime summary rather than trusting a persisted client reference.

### Mobile Validation

Before enabling a mobile coding-agent shell change broadly:

1. Run the touched mobile Jest tests and `pnpm --filter matrix-os-mobile exec tsc --noEmit`.
2. When the slice touches shared shell, gateway, or contract behavior, also run the matching gateway Vitest tests, shell typecheck, and the shell/mobile readiness tests listed in `docs/dev/mobile-shell.md`.
3. Confirm mobile persisted state contains only bounded UI references.
4. Open the Agents workspace, thread detail, approval/input controls, review/file detail, preview route, and bound terminal route in a dev client when the slice touches those surfaces.
5. Confirm Chat, Apps, Terminal, and Settings tabs still open.
6. Keep the existing terminal fallback. Do not land native terminal replacement behavior without separate device validation.

## Validation Commands

Run the smallest focused tests for the touched surface, then the shared gates that apply:

```bash
pnpm exec vitest run tests/contracts/coding-agents.test.ts tests/gateway/coding-agents-summary.test.ts
pnpm --filter desktop run typecheck
pnpm --dir apps/mobile exec jest --runInBand
pnpm --filter matrix-os-mobile exec tsc --noEmit
bun run test tests/shell/terminal-app-component.test.tsx tests/shell/mobile-shell.test.tsx tests/shell/mobile-canvas.test.tsx tests/shell/user-button-hydration.test.tsx tests/shell/app-launch.test.ts tests/shell/app-viewer-slug.test.ts
bun run test tests/gateway/terminal-ws.test.ts
pnpm --dir shell exec tsc --noEmit
bun run check:patterns
bun run typecheck
git diff --check
```

For mobile-only changes, prefer the mobile Jest command for touched tests first. For shared shell, gateway, or contract changes, keep the shell/mobile readiness commands in the block. For gateway routes/services/contracts, use focused Vitest tests before broad typecheck.
