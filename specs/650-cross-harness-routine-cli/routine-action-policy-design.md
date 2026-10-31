# Routine action authorization adapter

Status: implementation mapping confirmed within the previously approved five-harness scope by coordinator clarification on 2026-10-31. No further blanket design permission is pending. This authorizes implementation only; actual owner decisions, account operations, additional privileges, real provider calls and deployment remain separately controlled. The shared Terminal launch bridge remains approved.

## Existing evidence

Canonical admitted Chat runs carry authenticated permission/interaction modes. Full-access integration calls already use a live source policy plus exact request digest, but routines are not in that whitelist. Native OpenCode and Pi enforce a read-only native sandbox and have no write-approval port. Existing canonical approval cards carry actionDigest; generic provider submission/verification currently drops it. Terminal has no canonical source Chat/run, so a Chat run must not be invented for its permission prompt.

Source map: .trellis/tasks/10-31-cross-harness-routine-cli/research/routine-cli-current-action-policy-map.md. This is source inspection, not native runtime acceptance.

## Proposed minimum policy

| Actual source policy | list/show/request | propose/pause/resume/archive |
| --- | --- | --- |
| Personal Chat, default interaction, currently admitted full_access | Current source/read/target checks | Explicit routine policy mapping permits the exact current operation, then normal source/target/revision checks |
| Personal Chat supervised/auto/accept-edits, default interaction | Current source/read/target checks | Require one authenticated owner decision for this exact operation/invocation/target |
| Native OpenCode/Pi supervised with read-only native tools | Current source/read/target checks | Same explicit one-operation owner decision through a new typed host routine tool; native filesystem sandbox and Bash restrictions stay in force |
| Plan/review, shared/org, unsupported source/profile | Only when existing read policy permits | Deny; an action card cannot override these ceilings |
| Managed Matrix Pi | Actual managed-run policy and binding | Full access mapping or an explicitly supported one-operation owner decision; never cast its binding to BotTask |
| Verified Matrix Terminal native launch | Current kernel-backed source/read/target checks | Always require the one-operation owner decision; do not infer authority from --yolo, agent hints, CLI arguments or an invented Chat run |

The new supervised/Terminal decisions authorize one remote routine operation. They do not enable native shell/file writes, a persistent routine grant, background model consent, integrations or activation. A successful propose still means queued or pending human routine approval, never active.

## Exact decision and trusted owner path

A shared controller captures the actual host source handle and random host invocation UUID, resolves the original pinned target for duplicate/reconciliation or the current default for a new request, and hashes the strict operation + source generation + invocation + exact target incarnation + current policy fingerprint. All identities come from host/repository context.

For Chat, reuse the existing canonical pending-approval card and add a routine-specific submit branch that preserves the exact action digest. For Terminal, expose the same owner decision in the current Computer's shared UI, keyed to its real session/incarnation/launch; do not create a synthetic Chat/run. No approve-for-session or remembered action grant.

Use the existing platform authenticated-owner proxy/proof pattern with a narrow routine decision tuple. Chat/native source capabilities and generic agent/CLI credentials cannot mint this owner proof. The gateway validates actual configured owner+Computer and the exact stored challenge, proof, digest, decision and one-time request identity. New endpoints have explicit auth registration, bodyLimit and strict bounded schemas. A source capability cannot approve its own challenge or save a default.

UI waits occur outside transactions. Pending challenges/decision handles have hard count/TTL limits, source cancellation, expiry, shutdown drain and no late delivery. After owner approval, revalidate the same live source/policy/target before issuing the operation-bound capability. Consume checks the decision and current policy again while writing the durable receipt. Default changes never silently retarget the decision; policy/source changes fail closed.

## Independent approval boundaries

1. Owner chooses/remembers the destination; this is routing state only.
2. Current source policy or exact owner action decision permits this CLI operation.
3. ENG-93 creates a real canonical pending approval and separately validates background model authorization.
4. Existing integration permissions and routine activation remain canonical and independently checked.

No real owner decision/grant/account test is performed as part of implementing this adapter. Such tests remain separately authorized.

## Verification

Add failing tests first for self-approval/source-token/JWT-fallback rejection, altered digest/target/invocation/source generation, replay/late/duplicate answers, decline/timeout/cancel, changed policy during wait and consume, full-access current-policy mapping, plan/review denial, supervised exact one-operation approval and unchanged native read-only/Bash restrictions. Chat and Terminal use real distinct source kinds. Test actual owner proof producer/consumer and submit routing rather than local replicas. Fixtures are labeled and do not establish live human/native acceptance.
