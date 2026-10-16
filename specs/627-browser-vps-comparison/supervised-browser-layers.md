# Supervised browser approval: three-layer delivery plan

## Source and gates

One owner delivers BROWSER-R7 across three dependent GitHub PRs. No production
implementation is unlocked by this plan. Source order is R5 Codex transport →
[R8 Chat naming #2660](https://github.com/HamedMP/matrix-os/pull/2660) →
[R6 failed-bootstrap retry #2659](https://github.com/HamedMP/matrix-os/pull/2659)
→ A authority/contracts → B broker/native → C shared Figma UI. Layer A starts
on exact R6 source `1b4d47c729b208f84e47ae24c581c90f8032137c`. Use GitHub's
native stack links under [browser stack #2621](https://github.com/HamedMP/matrix-os/pull/2621).

The earlier two native/broker RED files are preserved separately for layer B;
they are not part of the layer A authority-only bootstrap. No existing R5
transport, R6 retry, R8 copy or unrelated approval-owner work may be overwritten.

Established by root's isolated VPS execution, not local tests:

- Two admission tests fail semantically because the supervised native browser
  lease is absent.
- The real broker/canonical owner-route boundary test fails semantically because
  the driver executes before the human decision.
- The original boundary fixture's invalid semver was corrected to `1.0.0`
  before the actual broker RED was established; collection failure is not RED.

## A — Authority, typed contracts and owner decisions

Proposed branch: `codex/browser-approval-authority`.
Target: 15–22 files and approximately 1,500–2,200 changed lines, including tests.
Root reviews actual size before unlock; estimates are not permission to exceed
the 3,000-line / 50-file review bound.

Responsibilities and focused files:

1. `packages/contracts/src/browser-chat-approval.ts` and focused export/wire
   integration: strict typed challenge/expiry/decision/grant/revoke contracts,
   canonical `allow_once`, `allow_in_chat`, `not_now` semantics and additive
   compatibility for existing approvals. No native `approve_for_session` alias.
2. `packages/platform/src/browser-chat-approval-proof.ts`: domain-separated
   platform signature binding authenticated actor, runtime/handle, Chat, Run,
   approval, epoch, digest, explicit browser decision, scope version, expected
   revision, client request, nonce and short expiry. A separate revoke payload
   binds owner/Chat/grant/revision/method/body and is not tied to a live Run.
3. Extract current bounded canonical approval body/session handling from the
   1,000+ line `session-routing-middleware.ts` into a focused injected helper,
   preserving old export compatibility and existing integration semantics.
   Add browser dispatch there; strip caller proof headers and add only the
   server-produced browser header on the authenticated proxy path.
4. `packages/platform/src/browser-chat-approval-routes.ts`: machine-authenticated
   online verification of the platform-held proof and exact expected tuple.
   Machine transport alone returns denial. The Gateway never receives the
   platform signing secret and cannot mint human consent from host HMAC.
5. `packages/gateway/src/chat/browser-approval-platform-client.ts`: fixed
   configured platform endpoint, scoped machine transport, bounded strict
   responses, timeout and redirect rejection. The pending controller supplies
   the expected tuple; model arguments do not select it.
6. `packages/gateway/src/chat/browser-approval-repository.ts` plus focused
   migration module: owner Postgres metadata for challenge claims, decision
   nonces and Chat grants, atomic grant+challenge transition, CAS revocation,
   idempotency/caps/retention. Register migration through a thin existing DB
   composition call; extract the touched migration responsibility first.

Layer A bootstrap test:
`tests/platform/browser-chat-approval-proof.test.ts` invokes the existing real
`authenticatedApprovalProxyProof` boundary with the explicitly typed browser
body. Root's isolated remote execution established two positive cases return
null and fail semantically; seven focused existing/new authority controls pass.
It adds no unavailable-module import. When extraction is implemented,
move the boundary import with its production call sites while preserving the
same behavioral assertions. This does not prove broker execution or live UI.

Before A production unlock, expand focused RED coverage for strict contracts,
signed tuple tampering, wrong proof domain, session expiry during bounded body
reading, exact handle/runtime binding, caller-supplied proof overwrite and
machine-only rejection. Add real disposable-Postgres transaction/race tests for
grant/create/revoke/consume, nonce replay and cleanup. Existing integration
proof tests must remain green without weaker sources or new accepted decisions.

## B — Broker enforcement and native adapters

Proposed branch: `codex/browser-approval-broker-native`, based on A.
Target: 12–18 files / approximately 1,200–2,000 changed lines.

- Add the immutable server-created authorization policy to browser leases.
  Delegate policy and bounded pending state to a focused
  `shared-browser/approval-control.ts`; gate actual driver dispatch once.
- Route capability-originated actions through that policy, including direct
  bearer calls. No approval flag/token/digest supplied by the model can release
  a request. A policy that cannot verify consent denies.
- Extract a small native browser approval event/control bridge for Codex and
  Claude. Merge its canonical events into existing queues, and dispatch its
  exact pending approvals before other native approvals. Extract the touched
  Claude/orchestrator composition responsibility before adding behavior to
  their 1,000+ line entrypoints.
- Change native admission to offer supervised discovery with default-denied
  execution until the broker authorizer is present. Qualify current Claude and
  Codex native confirmation transports with isolated fixtures. Preserve R5's
  bootstrap transport and R6's failed-start retry files; root resolves any
  unavoidable cross-owner edit explicitly.
- Persist only metadata; pending parsed actions/bearers remain bounded memory.
  Abort/stop/expiry/grant revoke/control revision fence release, and observation
  validation still runs after waiting. Shutdown drains all owned work.

Move the existing two bootstrap RED files into this layer. Extend with wrong
owner/Chat/Run/epoch/action/revision, forged direct bearer calls, denial,
expiry/cancellation/shutdown, simultaneous decisions, revoke/consume races,
takeover while awaiting approval, no stale-ref replay and Full access controls.
Use the real canonical route/repository path and both native harness fixtures;
mocked UI/native permission text is not browser authority.

## C — Shared Figma experience and public guidance

Proposed branch: `codex/browser-approval-chat-experience`, based on B.
Target: 15–22 files / approximately 1,400–2,200 changed lines.

- Pure shared derivation in contracts/UI for Waiting, Allowed, Not now,
  Expired, remembered grant and revocation/error states. Add a reusable shared
  approval card and compact composer reminder; do not duplicate authorization
  derivation across Web Canvas, Web Desktop and Electron Desktop.
- Wire canonical Needs you, same-Chat navigation, safe what/why copy and exact
  pending submission into the existing hosts. Preserve active-route/revision
  guards and show expired controls as unavailable.
- Add distinct Allow once / Allow in this Chat / Not now. Remembered grants
  display their actual same-profile/signed-in-account scope and Undo. Explain
  current runtime boundaries truthfully; prompt instructions are not a claimed
  credential-page exclusion.
- Always allow opens the existing mode menu; selection affects next request
  only. Try again admits fresh reviewed work rather than resurrecting an expired
  receipt or replaying an uncertain browser action.
- Carry equivalent meaning/actions into Web Mobile and Native Mobile wherever
  browser Chat tools exist, documenting an actual platform limitation if any.
- Open a separate `FinnaAI/matrix-os-site` documentation PR with the plain
  browser prompts, explicit permission/grant/Undo/expiry/takeover behavior.

Test shared derivation, all action mappings, disclosure bounds, route changes,
reload/reconnect, expired/grant-revoked races, accessibility and narrow layouts.
Run React Doctor remotely. Root captures actual Web Canvas/Web Desktop and
Electron Desktop when permitted; local Electron/build/test work remains off.
Seek design/ENG-267 stakeholder review without inventing another consent gate.

## Live candidate and security acceptance plan

The current app-domain owner proxy overwrites the incoming Authorization header
with a machine bearer, then sets generic actor headers. Those host-verifiable
headers cannot serve as the new human-approval evidence. A is incomplete for
live acceptance until its reviewed platform signer/verifier and B's host runtime
are reachable through one exact authenticated path.

Test the complete platform proxy → new browser proof → Gateway owner route →
online platform verification → owner DB conditional claim → broker with synthetic
keys/owners first. Verify both `clerk-browser` and `clerk-device` provenance,
expired session and opaque app/static-route denials, machine-only requests,
spoofed headers, wrong handle/runtime/Chat, request tampering and duplicate
nonce. Real browser selection must use the same reviewed candidate for browser
POST and Gateway internal verification; an Edge marker alone proves neither.

For live qualification, preserve the existing exact PR/preview-handle/tag
selector invariant and two-hour expiry. No relaxed selector, reused operator
payload, new VM or default-traffic deployment is authorized by this plan.
Root must inspect an already authorized matching preview path. If no such path
exists, report live platform acceptance pending and prepare the exact candidate,
source/target and rollback proposal for separate operator review. Do not make
the platform-wide signing secret available on the VPS to avoid that dependency.

Each layer gets its own current-head CI and Greptile 5/5, then `ready-for-ci`;
none is merged without the user's separate merge authorization. Keep the
feature disabled until A+B+C and the exact live proof path pass their gates.
