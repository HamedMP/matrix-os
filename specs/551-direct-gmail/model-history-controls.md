# Model-history controls (ENG-355)

Status: implementation foundations, not deployed to production. Stack: Gmail
verification readiness, following the explicit consent layer. See
`provider-data-controls.md` for the immutable plan.

## Trust and transaction boundary

`createGoogleModelHistoryStore` classifies only canonical chats that received an
opaque, single-use receipt during their successful empty-chat insert transaction.
Replayed creates, imports, organization chats, old rows and timestamp/text guesses
cannot certify history. An expired, purging or deleted Google marker always wins
over an ordinary birth. Existing unknown chats remain owner-readable.

`createGoogleModelHistoryReader` is a private model-only boundary. It supplies a
transaction-bound ChatRepository to the read callback. The same transaction holds
context advisory lock 551035504 through classification, reference inheritance and
actual text/state loading; content and inherited markers roll back together. A
caller transaction retains the lock until its own commit. Statements have a 5s
timeout, locks 2s; the admission wrapper bounds reads at 10s and withholds late
results after caller cancellation or changed/expired classification.
It rechecks the captured deadline and cancellation after COMMIT/post-commit work,
before releasing the value. On cancellation, the complete callback and its already
queued queries drain before rollback can release the connection or purge fence.
Callbacks are trusted finite database reads, not external calls or unbounded waits;
the linked signal is also supplied to them. Reference authorization occurs outside
that callback. Owner/ID inputs are snapshotted before admission awaits.
The read repository closes its query/result plugin when the callback settles or
cancellation wins. A final query on the original transaction drains existing
siblings even if Promise.all rejected early. Reviewed callbacks use normal builder
queries only: precompiled execution, plugin removal and unfinished streams bypass
this plugin and are forbidden in this private callback seam. A barrier is a drain,
not processing authority; an aborted-transaction barrier still causes rollback.

References inherit all Google origins and the earliest deadline before loading
text. Own Google history also requires the privately registered guarded adapter
object; matching a public driver name or request flag is insufficient. This check
does not approve a provider, profile, current consent or external dispatch.

Optional modelHistory hooks on session-history and resume-checkpoint run before
all early returns, including cached context, existing resumes, empty histories and
bot sessions. Their callbacks use the supplied transaction-bound repository.
Ordinary authenticated owner preview/export bypasses these model-only hooks.

## Evidence and remaining work

The existing 1,199-line orchestrator is refactor debt. New policy belongs in the
focused model-history reader, not that class. This increment only forwards the
dependency and calls its boundary. Before further orchestration behavior, extract
queued-run preparation and the dispatch runner into focused modules below 500
lines; the 2,094-line legacy orchestration test receives no added cases.

Real PostgreSQL tests cover purge-lock fencing during actual detail reads,
transaction reuse, timeout settings, inheritance rollback/commit, unknown history
and cancellation. Separate behavior tests cover all early-return and opaque-state
paths and supplied-repository wiring. Birth/import tests remain unchanged.
The composed focused run passes 161 tests across 13 suites, including canonical
Chat orchestration/context regressions, queued SQL after cancellation/early
failure, closed scopes, post-COMMIT abort/expiry, mutable scope substitution and
the optional Pi session copy adapter. The later Pi COMMIT-return fix passes 35
focused tests including the existing state repository regression; it withholds
results after cancellation or the earliest captured context/source/copy expiry.
Gateway type checking passes. This is local test evidence only.

Optional turn/retry/queue/reference composition now forwards the gate and the
actual registry adapter. Dispatch checks again after durable run preparation,
immediately before adapter invocation; queued work repeats admission after its
wait. The host must install the same reader in the agent context and orchestrator.

Owner-database startup now constructs the repository with the genuine creation
hook and awaits both canonical and history schemas before exposing it. Four real
database cases plus ten startup/fallback regressions pass. Old/replayed chats stay
unknown, rollback removes both chat and birth, and pool ownership stays with host.

Not yet installed: production model-admission/runtime installation,
exact registered-adapter qualification, saved session/content copy ledger,
content deletion handlers and scheduler. Root plan P3 is therefore incomplete.
No legacy backfill, provider approval, live mailbox test or deployment is implied.

## Continuations

When the host supplies the reader, active and queued steering, owner answers and
approval continuations repeat admission with the exact registered active adapter
and live run signal after their final awaited state read. Refused steering leaves
queued owner input pending; refused approvals remain unaccepted; unsent answers reopen their existing
retry claim. A refused decline/cancel quiesces the run through canonical Stop
instead of forwarding a decision that could resume a provider on closed history.
Existing Stop semantics may promote queued work afterward; its own history gate
still refuses closed context before any adapter dispatch. No queue-hold behavior is added.

`withCanonicalChatHistory` is optional host composition for asynchronous question
adapters. Its inner guard uses the final registered wrapper identity at every
native phase or deferred send, including after queued delivery waits. It does not
install a reader globally; controlled startup composition must supply the same
reader to wrappers and orchestrator. Provider/profile consent remains separate.
Callbacks are trusted finite database reads; precompiled queries, plugin removal,
streams and arbitrary external callback work are outside this admission contract.
