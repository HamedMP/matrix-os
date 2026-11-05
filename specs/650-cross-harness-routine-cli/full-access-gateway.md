# Routine CLI Full Access scope and source binding

Status: owner-approved source and isolated tests implemented; matching Platform/runtime deployment and real lifecycle acceptance remain pending. Runtime parent is `8d2ee4f0322f3ed27ffe84d755ffdb212b1cf7e1`. The separate Platform contract is Draft #3137 at `8ba3dfc43080a1b316d8a6691fbeb0fb871d79d6`, based on serving source `066c4cb8bc2779550534109215f099b0866f2283`.

## 1. Scope / Trigger

An ordinary private Claude Chat selected as Full Access may skip individual routine proposal/control confirmations only after explicit owner scope consent and a fresh qualifying browser turn. Reuse the existing `matrix routines` CLI, native callback, canonical Bot backend, target preference, revisions, approvals, scheduler and cancellation. No new executor, MCP, key, model authorization or integration permission is introduced.

The scope covers the current private canonical Bot destination and `read`, `propose`, `control`. Selecting Full Access, seeing a scope reference, authenticating a runtime request or reading an old receipt grants nothing. Routine creation remains a proposal pending separate human activation and valid task-scoped model consent. Broad background authorization is never enabled by this feature.

## 2. Signatures and auth matrix

The existing CLI tree and JSON envelopes are unchanged. All management routes below are private and reject query parameters; every mutating body is strictly decoded and limited to 4000 bytes.

| Route | Required boundary | Result |
| --- | --- | --- |
| GET `/api/chats/:chatId/routine-cli/full-access` | Existing authenticated owner principal and locked current personal/private active Chat | Safe status/revision; no authority |
| POST `.../challenges` | Same owner; `{baseRevision}` CAS and current default private Bot target | Server nonce, scope digest and expiry; no consent |
| POST `.../challenges/:challengeId/decision` | Same owner plus positive purpose-specific Platform browser proof | Explicit `approve` or `decline` for the stored scope digest and decision `clientRequestId` |
| POST `.../revoke` | Same owner and `{baseRevision}` CAS | Invalidate this scope and its Run leases; never grant or stop a routine |
| POST `/api/chats/:chatId/turns` | Existing admission; fresh matching browser proof and live consent | Only a newly accepted personal/default/Full Access Claude Run can acquire an internal lease |
| POST `/internal/containers/:handle/routine-full-access/verify` on Platform | Existing Computer transport token, exact purpose proof and current machine/owner/runtime-slot | Verify only; cannot create consent or a native binding |

`createRoutineFullAccessService` exposes `status`, `createChallenge`, `submitDecision`, `revoke`, `beforeTurnDispatch`, `bindSource`, `close`. Admission calls the private hook only for its actual fresh accepted Run; duplicate fast paths, queues, retries and automatic continuations do not inherit it. `createChatRoutineSourceProducer` binds only the first actual native Claude source generation and retains the existing current-process/native callback guards.

## 3. Request, response and lifetime contracts

Shared Zod decoders live in `contracts/routine-full-access.ts` and `routine-full-access-view.ts`; clients never import Gateway implementation types. A challenge/scope selector is `rcfull_` plus 32 lowercase hex characters. A decision has only `{scopeDigest, decision, clientRequestId}`. Status is `{revision, eligibility, consent, challenge, origin: "browser_required"}` with a safe fixed target/actions/expiry projection. Native generation, binding incarnation and preference snapshot remain server-only.

Platform supplies `x-matrix-routine-full-access-proof` after verifying eligible owner-browser provenance. For a new turn, the browser adds only the nonsecret `x-matrix-routine-full-access-scope` selector as origin transport. Both proof kinds use purpose `routine_cli_full_access_origin` and bind the actual routed owner/machine/slot/Chat. A `scope_decision` proof additionally binds the stored challenge, scope digest, explicit decision and `clientRequestId`; a `turn` proof binds the scope selector, exact canonical request digest and turn `clientRequestId`. These attestations are verified separately from the Gateway's live consent. Decision request IDs accept a UUID or `req_` plus 32 lowercase hex characters; turn request IDs use the existing canonical `req_` request-ID schema. Caller proof headers are stripped by Platform. Turn digest includes the full parsed request, including `baseRevision`; it does not replace the existing admission duplicate hash.

Gateway retains at most 128 scope entries and 256 Run leases across configured owners, with capped nonce tracking, recurring expiry eviction and shutdown drain. Proofs expire within 60 seconds; replay entries retain only that original proof expiry. A scope expires at its original server challenge deadline, at most 30 minutes after challenge creation. Approval, duplicate decisions and later turns do not extend that deadline. Approved consent may cover multiple fresh qualifying turns until that deadline unless revoked or invalidated. Each turn needs its own fresh browser attestation and newly admitted source binding; the Run lease cannot outlive that consent, native source or Run. Closing the source releases that Run lease while leaving otherwise valid scope consent at its original deadline. It cannot revive the old Run or transfer its lease to another generation.

Status revision advances on decisions/revocation; immutable scope policy revision, digest and expiry remain separate. Restart reconstructs neither consent nor leases. No lease/proof is placed in persisted Run DTOs, provider prompts, tool arguments, environment, CLI output or browser storage.

Use the existing preference → owner → source Chat/Run → target Chat/binding lock order; canonical control retains its existing routine-row prefix. Resolve the owner default through the read-only target port, never a fabricated native source. Retain the immutable admitted Run selection and, before issue and consume, recheck the exact target, preference revision, binding incarnation, owner, Computer, live Run mode/policy and native generation. Target drift, privacy/lifecycle changes, downgrade, revocation, observed verification failure, source closure or expiry invalidate the affected lease. An invalidated source cannot silently follow a new target or recover old rights.

## 4. Validation and error matrix

| Observation | Required behavior |
| --- | --- |
| Mode/selector/runtime bearer without consent and fresh browser proof | Existing ceiling; no full lease |
| Wrong/expired/replayed proof or matching admission/decision drift | Deny; invalidate only the affected scope/leases |
| Wrong owner/Computer/Chat/target or native generation | Deny before canonical mutation |
| Stale management/control revision | Safe revision conflict; refresh and reconsider intent |
| Unknown result, source cancellation or lost acknowledgement | Retain original UUID and history; reconcile without automatic mutation replay |
| Missing service or observed verifier failure | Safe unavailable status; local GET cannot claim the remote verifier recovered |
| Explicit new review/decision after failure | May try a new bounded challenge; only successful fresh proof clears observed unavailability |
| Archived or uncertain execution | Existing ENG-93 state rules remain authoritative; revoking CLI scope never proves an execution stopped |

All errors use bounded safe codes/messages. No provider, database, path, token or raw exception is shown to the client. Transactional waits never include browser/network approval waits.

## 5. Good, base and bad cases

Good: the owner reviews one fixed private destination and deadline, allows the scope in the browser, then submits a new qualified Claude turn. Its real native CLI invocation can propose or control through the existing backend without a per-operation card. The proposal still waits for independent human schedule approval.

Base: an older client, device-only session or missing proof retains exact-operation confirmation. A same-Claude model/options change that keeps Full Access/default may retain the scope, but each new turn still needs its own exact attestation and admitted immutable selection. A provider/mode/interaction change that leaves the qualified policy revokes before committing the UI downgrade.

Bad: raising `originCeiling` from a permission string, upgrading an already accepted Run on duplicate admission, rebuilding a lease after restart, copying a caller's Run/PID, treating scope approval as schedule activation, or inferring stopped execution from cancellation acknowledgement.

Web Desktop, Web Canvas and applicable Web Mobile share the controller/presentation and actual selected-detail privacy gate. Electron Desktop offers the existing owner-browser handoff and keeps its device turn ceiling. A successful handoff does not attest later device turns. OpenCode and Terminal native qualification are not enabled by this change.

## 6. Tests required and evidence limits

Keep behavioral Red/Green cases for fresh admission versus duplicates/queue/retry, unproven modes, proof purpose/tuple/expiry/replay, cross-scope requests, status CAS, target/preference/binding changes, native generation/source closure, observed service failure, and downgrade including implicit provider/plan changes. Assert denied paths have no canonical mutation or background permission write.

`routine-cli-full-access.postgres.integration.ts` exercises the published CLI child IPC, real capability issue/consume, canonical pause/archive/history, UUID deduplication and multi-connection advisory-lock contention. Its Platform response and native `current()` observation are explicitly component fixtures. Retain the existing exact-operation/Supervised 30-minute PostgreSQL suites. These tests do not establish live Platform signing, OS-native process identity or account acceptance.

UI tests must exercise actual pending owner/Computer/Chat switches, revoke failure before selection changes, device headers remaining absent, shared/private gating, and current Web/Electron CSS at narrow/wide light/dark sizes. No local render, build, fixture or scope label substitutes for the complete matching-version real proposal → human activation → delayed result → pause/resume → archive/history flow. Record the demo only after that gate passes.

## 7. Wrong versus correct

```ts
// Wrong: permission selection is not origin authority.
originCeiling = input.permissionMode === "full_access" ? "full" : "exact";

// Correct: bind a host-private lease; currentness independently gates use.
originCeiling = lease ? "full" : "exact";
live = options.current() && !options.signal.aborted && (!lease || lease.current());
// Existing native plan narrowing still forces the read ceiling.
```

Keep future harnesses behind the same trusted admission boundary after their native binding is qualified. Capability discovery, documentation MCP and skills remain Nima-owned. Public user instructions are maintained separately in matrix-os-site Draft #319.
