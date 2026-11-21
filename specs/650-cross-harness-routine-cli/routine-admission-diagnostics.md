# Canonical handoff diagnostics

## Problem and scope

A persisted routine CLI proposal can finish its canonical handoff in `unknown` while the only operator warning records the exception type. That warning does not distinguish a safe canonical admission refusal from another exception, nor correlate the generated canonical request with the original CLI request. This prevents bounded diagnosis without replaying an uncertain intent.

Add internal diagnostic fields only. The existing CLI envelopes, revision/state transitions, approval model, trusted source binding, scheduler, cancellation semantics and no-replay behavior remain unchanged. This does not recover or retry any live proposal.

## Contract

The canonical handoff warning carries the schema-validated original CLI request ID, the host-generated canonical request ID, a fixed error category, and an allowlisted canonical error code when the error is the real typed canonical orchestration error. Noncanonical failures use a fixed generic category. Never serialize arbitrary exception names, message, stack, provider/model configuration, owner/Chat identity, credentials, tokens or account data.

Encode the safe fields as one compact JSON log line with the warning label, so journal filtering retains the category, code and both request IDs together. Exercise the actual Node console-formatting boundary; a multi-line object payload loses its fields when filtering only by the warning label.

The log is private operator evidence, not a client authorization result or an assertion that execution stopped. An `unknown` proposal stays uncertain even when a refusal code is observed. An operator must correlate the exact request/hash and durable queue/turn records before deciding what happened; the warning never authorizes a retry.

## Verification

1. First demonstrate the missing fields on the original source through a genuine canonical pre-admission refusal using the existing real PostgreSQL fixture and real canonical orchestration/catalog validation boundary. Missing dependencies or fixture failures are not Red.
2. With the change, assert the same refusal leaves no matching canonical queue/turn admission and retains `unknown` at proposal revision 3. Reads and an identical duplicate must not dispatch the proposal again.
3. Assert the correlated IDs and safe category/code are present; raw error/secret sentinels and unrelated metadata are absent. Assert the formatted warning is a single line, and exercise the generic noncanonical fallback.
4. Run focused adjacent proposal/continuation tests, typecheck, pattern checks and independent review. Report full CI/Greptile separately.
5. Ship a separate Draft PR above the frozen acceptance source. Build and install the exact resulting source on the selected Dev only after the code checks pass; no shared Platform deployment or permission/configuration change is needed for these internal logs.

## Live acceptance and docs

Earlier uncertain requests remain retained and unreplayed. Diagnostic-source installation does not establish a live lifecycle pass. A subsequent explicitly reviewed new test intent needs a current verified browser source scope and separate human activation, then matching delayed output, duplicate/stale revision, pause/resume/archive and retained-history evidence before the English demonstration.

The existing public guide PR remains the source-Chat/native coexistence deliverable. This internal-log addition does not change public commands, output fields or user flow; no new documentation MCP or scheduler is introduced. Private operator receipts and actual account/Chat/request details stay outside the public repository.
