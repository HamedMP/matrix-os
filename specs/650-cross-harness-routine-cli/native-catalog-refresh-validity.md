# Preserve a still-valid native catalog across transient refresh failure

## Observed failure boundary

Native catalog refresh begins before the existing five-minute inference validity expires. Currently any failed refresh, including a timeout, immediately clears the catalog, aborts native requests and stops the peer. This can interrupt an already qualified source while its last successful catalog is still inside the existing validity budget. Two bounded live failure windows contain allowlisted native catalog-timeout records; one exactly matches the first failed occurrence timestamp. The first failure was after canonical admission; the later uncertain occurrence had no corresponding new run in a bounded read. These observations support this boundary but do not prove every historical outcome or qualify a repair.

Implement a native-only repair. No new proof, wire field, key, account, permission, scheduler or daemon. Do not extend the existing five-minute freshness limit or restore an old/disconnected source from cached data.

## Contract

- Retain a prior successful catalog only after an explicitly classified transient refresh timeout/network failure, while the original catalog is still fresh and the exact source, account, credential, grant and connection generation remain current. Initial failure without a qualified catalog still fails closed.
- A failed refresh must not update catalogAt, extend its expiry, alter the peer signature, grant background access or resuscitate a stopped/changed peer. Keep the existing bounded refresh retry behavior; do not add an unbounded/tight retry loop.
- Caller cancellation, explicit disconnect/revocation, identity/credential/account/grant/generation changes, authentication failures, schema failures and unclassified errors must retain their immediate fail-closed behavior. Classify the bounded original transport cause chain before diagnostic sanitization: an allowed outer reset must not hide an unknown or TLS/security cause, and arbitrary typed network/timeout exceptions do not confer retention authority. Validate current authority again after asynchronous waits.
- Enforce the original freshness deadline in snapshot projection, the peer's qualification callback and inference, with one owned expiry timer that aborts/stops the current native source at its existing deadline. Clear the timer on shutdown/replacement; stale timers must never cancel a newer successful catalog.
- Only a successful fresh catalog can advance freshness. An identical successful refresh must not restart the peer or abort active inference; existing peer-signature lifetime guarantees remain intact.
- The current server wire has no catalog-expiry timestamp. A lost disconnect can therefore leave remote availability projection behind local expiry until the existing heartbeat detects it. Document that limitation: native execution must still reject at the original deadline, and availability is not an execution guarantee. Strict remote non-advertisement would need a separately reviewed compatible protocol change and is deferred.

## Test-first verification

1. Demonstrate meaningful Red through the real native service/catalog refresh and peer-lifetime callback: a successful catalog followed by a transient timed-out refresh within its original validity must not clear that still-valid same-authority source or abort its current request. Keep producer/consumer state real; a fixture/setup failure is not Red.
2. Advance past the original five-minute deadline after failure and assert snapshot/qualification/inference rejection and owned peer/stream cancellation. Failure must not extend the deadline. No stale cached authority after disconnect or an account/grant/generation/credential change.
3. Cover an initial failed catalog, non-transient/auth/schema failures, cancellation, a successful renewal, and stale refresh/timer races. Retain existing no-restart behavior for identical successful metadata.
4. Run appropriate native catalog/service/peer lifetime tests and types, patterns and independent review. No real credentials, provider calls or account tests in isolation.

## Delivery and acceptance

Use an independent Draft PR and exact dependency commits. The manual worktree may start from the test-only base while the preceding browser-response fix is reviewed; main will fast-forward its uncommitted native-only work onto that qualified parent before final checks/commit. Preserve unrelated worktrees and data.

After source checks, build and install an exact native QA payload and Dev bundle using existing authorized resources/profile. Confirm actual source eligibility, then a separately manually approved bounded new test intent, delayed original-Chat result, pause/idle/resume/new result and archive/history before the English demonstration. Never replay an uncertain occurrence, claim physical stop from cancellation acknowledgement, or use isolation checks as live acceptance. Existing public source-Chat documentation remains a separate Draft guide; no public command or permission contract changes.
