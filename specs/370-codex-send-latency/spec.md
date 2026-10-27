# ENG-370: Codex Chat send latency

## Goal

Identify where Codex Chat send time is spent and remove the blocking model lookup on a verified catalog's ordinary expiry. Preserve current provider, account, consent, execution, and Browser authorization.

## Affected path

Canonical Chat admission reads a fresh provider catalog before it commits the turn. The Codex model source starts a separate app-server when its 60-second cache expires. A Codex runner then proves native account authority, starts or resumes a native thread, verifies Browser MCP when a lease exists, and starts the turn. Chat persists projected text before notifying subscribers.

## Behavior

- A verified model catalog is fresh for 60 seconds and may serve for at most five minutes while one background refresh runs. A cold lookup or a read after the stale window still waits for discovery. A failed refresh gets the existing short retry backoff.
- The cache key includes the current provider auth/install state and local credential, owner Settings, and executable file identities. The Settings file covers native account selection when Codex uses an OS keyring. Availability loss clears the cache. An earlier in-flight lookup cannot refill it after revocation or identity change.
- Every admission still performs the existing current provider and Settings observation, model validation, native account proof, execution authorization, and per-run Browser lease checks. Catalog metadata grants no execution authority.
- Set `MATRIX_CODEX_SEND_TIMINGS=1` on the gateway to emit timings. The default keeps diagnostic log volume out of ordinary sends. Timings report only opaque correlation IDs, fixed stage names, and durations. They never include prompts, credentials, account names, paths, or provider output. `first_displayable_text` is measured from dispatch start to persisted and subscriber-notified text; client paint is outside this backend measure.

## Browser startup decision

The Browser lease token currently enters the child environment and thread MCP configuration. Reusing the same native child with a different lease would retain the prior run's authority, so the follow-up close and restart remains necessary until a broker design can rotate authority within a live process. The startup timings separate process readiness, thread readiness, Browser MCP readiness, and prior-session close to determine whether that redesign is worthwhile on a real runtime.

## Acceptance and risks

- Focused tests cover expiry, bounded stale reads, account/executable invalidation, revocation during an in-flight lookup, lease renewal, cancellation, and cleanup.
- Capture comparable first and follow-up turns on an installed Matrix runtime before and after deploying the change. Report Codex version and all stage durations. A standalone CLI run does not establish Chat or Browser timing.
- A stale catalog can name a model withdrawn within its five-minute window; native `turn/start` remains the final model authority and will reject it. Unexpected account storage layouts should be checked on the target runtime.

## Validation environment

The unattended workspace has Codex CLI 0.162.1, but its app-server exits with `Read-only file system (os error 30)` while trying to write to the account directory. The workspace has no writable authenticated Matrix runtime, so before/after end-to-end timings remain an external validation blocker.
