# Spec Quality Gates

Every spec that adds endpoints, WebSockets, webhooks, IPC tools, or file I/O MUST include these sections. Run `/review-spec` before implementation to verify.

## 1. Security Architecture

- **Auth matrix**: table of every route/endpoint with auth method (bearer, HMAC, public, etc.)
- **Input validation plan**: what gets validated at each boundary (file paths, filenames, payloads, headers)
- **Error response policy**: generic messages to clients, detailed logs server-side. Never leak provider names, stack traces, or internal state.
- **Credential handling**: how secrets are passed (env vars, not URLs/logs/error messages)

## 2. Integration Wiring

- **Startup sequence**: what gets created, initialized, and connected in `server.ts` (or equivalent entry point). List every `new X()` and its `.initialize()` / `.connect()` call.
- **Cross-package communication**: how kernel IPC tools access gateway components. Never use `globalThis` -- use dependency injection or IPC messages.
- **Config injection**: how runtime config (phone numbers, webhook URLs, API keys) flows from config/env to the components that need them. No hardcoded placeholders.

## 3. Failure Modes

For every component that does I/O or manages state:

- **Timeouts**: all external fetches/dispatches have `AbortSignal.timeout()`. Specify default timeout values.
- **Concurrent access**: per-connection state (not shared closures). Atomic limit enforcement (no TOCTOU races).
- **Crash recovery**: atomic file writes (write to tmp, rename). Guard flags to prevent post-destroy side effects.
- **Error propagation**: errors reach the caller. Never swallow errors silently. Webhook handlers must return non-2xx on failure so providers retry.

## 4. Resource Management

- **Buffer limits**: max size for all in-memory collections (WebSocket buffers, event ID sets, audio chunks)
- **File cleanup**: TTL/rotation policies for generated files (audio, logs, JSONL)
- **Memory cleanup**: eviction callbacks must clean up ALL related state (maps, sets, timers)
- **Third-party data flow**: document any data sent to external services (e.g., Edge TTS sends text to Microsoft)

## 5. Integration Test Checkpoint

Each phase checkpoint must include:

- Unit tests pass (`bun run test`)
- Integration test that exercises the full end-to-end path (e.g., "initiate call via IPC tool -> Twilio API called -> webhook processes event -> call record persisted")
- Manual Docker verification scenario

## 6. Code Review Checklist

Every code review MUST check these failure-mode questions. Don't just verify "does it work" -- verify "what happens when it breaks":

**Error handling:**
- Does every `catch` block check the error type before returning a fallback? Bare `catch { return null }` hides real errors.
- Are errors from async fire-and-forget calls caught? (`.catch()` or try/catch with logging)
- Do error responses leak internal state? (stack traces, DB column names, provider names)

**Atomicity:**
- Do multi-step mutations use a transaction? (3+ sequential DB writes need BEGIN/COMMIT/ROLLBACK)
- Can a mid-flight crash leave inconsistent state? (orphaned rows, wrong counters, half-deleted cascades)
- Is there a TOCTOU race? (check-then-insert without unique constraint or lock)

**API contract:**
- Do response field names match what the frontend expects? (camelCase vs snake_case after DB migration)
- Are there dead code paths? (conditions that can never be true, like checking `array.length === 0` after pushing to it)
- Does the API return all fields the frontend reads? (liked, counts, timestamps)

**Type safety:**
- Are there `as` casts that skip validation? (cast `unknown` to typed object without checking)
- Do function signatures match their callers? (sync vs async, return type mismatches)
