# Specification Quality Checklist

Feature: [spec](../spec.md)

- [x] Outcome and bounded scope are explicit; deferred work (routes, tools, UI, wiring, cron, `brain_why`, fetching, force-push cleanup, secret scanning) is listed, not implied.
- [x] Repository identity, web base derivation, document kinds, stable id tuples, titles, bodies, permalinks and refs are complete and testable.
- [x] Spec file handling (globs, parts, stubs, tombstones on shrink and removal) is deterministic: each spec document is written with its content at the run's tip, so its final state is independent of window and run boundaries and a rescan never rolls it back.
- [x] The `brain_document_refs` store extension states its DDL, limits, single writer, replace-on-change rule, removal on every tombstone path, and the new bootstrap inventory.
- [x] The sync algorithm defines the cursor forms (applied, stopped short with its tip, in-progress token), windows, batches, rewrite detection and rescan, the run budget, and the result and receipt fields.
- [x] Security architecture covers the auth matrix (no routes; caller-resolved scope key and paths), input validation for repo paths, branch names, shas, globs, remote URLs and git output, the error response policy, and credential handling.
- [x] Git invocation is bounded and safe: `execFile` with an argv, no shell, timeout and maxBuffer on every call, scrubbed environment, pinned config, no network, never `HEAD` or the working tree.
- [x] Integration wiring states that nothing is wired here and names the planned caller and startup point.
- [x] Failure modes cover timeouts, rewritten history, concurrent access, crash recovery, partial failure, error propagation, repository state, large content, moving refs and shutdown.
- [x] Resource limits are listed with defaults, ceilings and enforcement points; memory, child processes, files and third-party data flow are bounded or absent.
- [x] Invariants (source of truth, lock and transaction scope, cursor, determinism, orphan states, auth source of truth, deferred scope) are stated.
- [x] Integration test checkpoint lists the required cases, the end-to-end path, the commands and a manual verification scenario.
- [x] Code review checklist covers git invocation, validation, error handling, cursor atomicity, bounds and store scoping.
- [x] Relationship to spec 551, PR #2078 and spec 115 is recorded.
- [x] Delivery splits the change into stacked PRs under 3,000 additions each and names the separate `FinnaAI/matrix-os-site` docs PR and the Greptile 5/5 merge gate.
- [x] OS-view surface matrix is N/A with a rationale (no UI, copy or route).
- [x] No unresolved clarification markers remain.
