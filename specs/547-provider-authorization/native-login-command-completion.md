# Codex Terminal login completion (ENG-268)

Restore normal Settings completion when an official native login finishes in a
held Terminal pane. Preserve independent native/Matrix AI identity, consent,
funding and revocation. This is the command-exit dependency of the native Codex Settings entry.

## Internal command result contract

`GetCommandResult` is an additive owner-only Unix-socket operation. Its strict
input requires workspace/tab IDs and the expected incarnation. The response is
`{state:"running"}`, `{state:"unknown"}`, or
`{state:"exited",exitCode:0..255}`. Only an exact non-plugin held pane with an
explicit integer exit status establishes a result. Missing, ambiguous, malformed,
out-of-range or replaced evidence returns unknown. Recheck incarnation and pane
coordinates after the read. No command text, credentials or process details are
returned. The existing `GetCommandState` coarse enum remains unchanged.

| Boundary | Authority | Mutation |
| --- | --- | --- |
| Internal command-result RPC | Existing owner Unix-socket permissions; exact incarnation | None |
| Native login completion | Existing foreground receipt, source/account proof and current owner revision | Existing private coordinator only |

No public HTTP/renderer completion proof, new persisted permission or credential
store is introduced. A Codex Terminal login without command-result support
fails before starting. An unavailable/mismatched runtime result cannot grant
success. Matching gateway and Terminal runtime bundles are required.

## Workflow lifetime and races

Each foreground Codex login has one nonoverlapping local result observer within the
existing ten-minute lifetime. Only explicit inner exit0 initiates existing fresh
native identity and private revision/consent completion; nonzero rejects. A
success banner, coarse `exited` state or attachment process exit is insufficient.
The exact pane remains visible; completion does not require closing it or
starting login again.

Cancellation, expiry, stream failure and shutdown stop observation. A common
abort fence covers both registered cleanup and the returned cancel method,
including failed cleanup/retry. Discard results and fresh-account reads arriving
after cancellation. Once the real store is already committing an admitted
selection, cancellation waits for that result: preserve committed success rather
than label it cancelled. Later owner Off and source/account drift retain their
existing revision protections. Never enable an unrelated key/funded source.

## Validation and rollout

Tests cover actual TerminalRuntime with a retained attachment. Test exact/nonzero/unknown results, RPC validation and
replacement, one-flight observation, cancellation/expiry, late reads, stream
close races, real private-store commit/cancel and intervening owner Off.
Synthetic identities/fake processes establish code behavior, not live OAuth.

Main's non-Codex Terminal login and install/cancel behavior remain unchanged. API-key preflight classification and the earlier generic install drain-cancellation repair are excluded. Existing running clients, credentials and Private Preview behavior are not changed by source validation. Final publication requires independent exact-diff review and current-head checks.
