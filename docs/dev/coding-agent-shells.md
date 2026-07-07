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
- A shell submits a decision or answer with a bounded `clientRequestId`.
- Gateway applies the first valid decision idempotently, appends the resolution event, and broadcasts it.
- Other shells update from the returned snapshot or stream event.

Client UI must disable duplicate submission while a decision is in flight and recover by rehydrating the thread snapshot on failure. User-facing errors should be generic and recovery-oriented.

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

## Validation Commands

Run the smallest focused tests for the touched surface, then the shared gates that apply:

```bash
pnpm exec vitest run tests/contracts/coding-agents.test.ts tests/gateway/coding-agents-summary.test.ts
pnpm --filter desktop run typecheck
pnpm --filter matrix-os-mobile run test
pnpm --filter matrix-os-mobile exec tsc --noEmit
bun run check:patterns
bun run typecheck
git diff --check
```

For mobile-only changes, prefer the mobile Jest command for touched tests first. For gateway routes/services/contracts, use focused Vitest tests before broad typecheck.
