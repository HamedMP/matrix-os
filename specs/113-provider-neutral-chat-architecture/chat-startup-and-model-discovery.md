# Canonical Chat startup, usage errors, and model discovery

Related delivery: OM-234. This supplements the [canonical Chat architecture](./spec.md).

## 1. Scope / Trigger

Use this contract when changing provider startup recovery, native error projection,
or model inventory. These cross the native process, canonical run, HTTP SSE, and
shared transcript boundaries. No new public event enum or database schema is needed.

## 2. Signatures

```ts
retryUnadmittedStartup<T>({ signal, attempt, onRetry }): Promise<T>
// onRetry({ retry: number, maxRetries: 5, label: string }): Promise<void>
// attempt may throw RetryableProviderStartupTimeout only with both proofs below.

// Dispatch-local lifecycle notifications, not client input:
CanonicalProviderRunInput.onCleanupUnconfirmed?: () => void
CanonicalProviderRunInput.onCleanupConfirmed?: () => void

readClaudeModelInventory({ executable, cwd, env, signal }): Promise<unknown>
createClaudeModelCatalogSource({ resolveContext, timeoutMs, cacheTtlMs })
classifyClaudeUsageFailure(value: unknown)
```

## 3. Contracts

- Retry proof requires **no prompt/session admission** plus **actual prior process
  exit**. Codex `initialize` and Hermes `gateway.ready` are the verified boundaries.
  Generic workspace readiness may happen after side effects and is not eligible.
- One initial attempt plus five retries; backoff is 250/500/1000/2000/4000 ms.
  A single logical run owns capacity throughout. Publish existing phase activity
  `Reconnecting… n/5` before waiting; do not invent tool work or reasoning text.
- Abort cancels scheduled retries. A cleanup deadline or sent kill signal is not
  exit evidence. Keep the exact child supervised and retain execution capacity
  until actual exit. Without explicit cancellation, pending cleanup stays
  nonterminal. Existing `cancelRun` may persist/display aborted immediately on
  user Stop; this is not cleanup proof and must not release execution ownership
  or authorize another dispatch. Emit one terminal outcome overall. Hermes
  confirmation clears only its dispatch-local unconfirmed flag. The persistent
  Codex runner owns its corresponding child wait.
- The Hermes async iterator owns its execution promise and cancellation signal.
  Consumer `return()` or consumer failure must abort and await that execution's
  cleanup before the iterator settles. An adapter-internal eventual-exit wait alone
  is insufficient when the orchestrator stops consuming after an early Stop.
- Persisted `activeRun` is not the only admission source of truth after Stop.
  Direct turns and explicit Retry must also check retained same-Chat execution
  ownership and recheck before dispatch, as queued work already does. A total or
  per-owner count below its cap does not prove this Chat is free. Preserve reads
  and idempotent replay of already-admitted requests without allowing new execution.
- Claude usage classification accepts bounded native error envelopes only. Weekly
  exhaustion maps to safe `run_failed`, `retryable: false`; explicit temporary
  throttling remains distinct. Never retry quota as startup timeout. Only validated
  explicit UTC reset dates in the next seven days are displayed.
- Inventory uses SDK `supportedModels()` without a user message, tools, hooks,
  MCP, persistence, or account-info reads; use the actual Chat executable and
  credential launch environment. Combined stdout/stderr budget is 1 MiB before
  SDK buffering; default deadline 5s; at most 64 validated/projected models.
- Cache/pending maps are owner-isolated and capped at 32. Context includes a
  private launch-environment digest and readiness/auth status. Explicit credentials:
  60s cache and at most 5min same-context last-good retention. Profile credentials:
  5s cache; explicit refresh discards it, including late pending writes. Do not
  inspect credential stores to establish a cache generation.
- Preserve default/opus/sonnet fallback. Offer native `value` or explicitly reported
  valid `resolvedModel`; never strip qualifiers, rewrite saved IDs, or imply account
  entitlement from metadata. Fable 5.1 is not a guaranteed fallback entry.
- No new auth route or credential choice: existing authenticated catalog and Chat
  routes retain principal/owner validation. No raw provider errors, paths, or
  credential digests are exposed in canonical events.

## 4. Validation & Error Matrix

| Condition | Required outcome |
| --- | --- |
| Proven pre-admission timeout and actual exit | Retry within the one budget |
| Sixth attempt times out | One safe final failure |
| Stop during handshake/backoff | No further attempt; one abort, execution retained until cleanup |
| Cleanup not confirmed | Retain ownership; no retry; no failure terminal absent explicit cancellation |
| Auth/install/model/permanent failure | Safe failure, no startup retry |
| Native weekly usage error | Usage-specific error, no Reconnecting loop |
| Successful prose mentions limits | Not authoritative quota evidence |
| Inventory invalid/unavailable/oversized | Bounded close and safe bounded fallback |
| Model metadata visible | Selection may be offered; generation remains unproven |

## 5. Good / Base / Bad Cases

- Good: first child times out before prompt; close is observed; second initializes;
  exactly one child receives `turn/start`, and SSE/rendering showed Reconnecting.
- Base: immediate readiness admits normally with unchanged session identity.
- Bad: a silent model or generic workspace timeout triggers duplicate tool execution.
  Also bad: claiming lost streaming text when native output never contained it.

## 6. Tests Required

- Hold terminal result/exit pending while real HTTP SSE and shared transcript
  assertions observe intermediate text/activity; frozen snapshot must not rescue it.
- Exercise success after first/fifth retry, exhaustion, permanent failure, Stop in
  handshake/backoff, late readiness, unknown cleanup, eventual real exit, and shutdown.
  Cover Stop both before and after cleanup-pending activity is emitted. An already
  aborted consumer must not detach the producer's eventual-exit ownership.
  Assert one terminal outcome and no duplicate native prompt/session calls.
- Feed real adapter quota envelopes through SSE/rendering, including assistant-only,
  assistant-plus-result, invalid/absent reset time, and ordinary prose controls.
- Exercise catalog refresh, owner/context changes, pending invalidation, fallback,
  selection persistence, exact launch/resume handoff, and real SDK protocol fixtures
  rejecting unintended user input and oversized output.
- Verify built gateway contains/imports both new `.mjs` startup helpers. Source-only
  TypeScript checks do not verify the packaging edge. Keep deterministic tests,
  build evidence, account availability, and exact-head Human Review separate.

## 7. Wrong vs Correct

```ts
// Wrong: timeout or a sent signal does not establish safe replay.
if (String(error).includes("timeout")) return retry();

// Correct: the adapter constructs the private proof only before prompt admission
// and after confirmed actual exit; the shared owner limits retries and emits phase.
if (error instanceof ReadyTimeout && stoppedBeforeAdmission) {
  throw new RetryableProviderStartupTimeout();
}
```

The owner must retain cleanup supervision even when the bounded stop attempt expires.
Never convert an unconfirmed child into a retryable error or a released busy slot.
