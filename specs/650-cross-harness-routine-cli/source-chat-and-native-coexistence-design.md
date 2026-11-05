# Source-Chat routines and native Claude scheduling

Status: approved by the owner's 2026-11-06 reply, "采用原生默认＋显式持久任务（推荐）".
The independent existing-wait-budget compatibility repair is
covered by `native-scheduler-compatibility.md` and does not wait on this policy.

## Intent and existing evidence

A user who starts a schedule in ordinary Claude Chat should approve it and see
its results in that Chat. Existing native Claude Cron already does this within
its bounded retained-session contract. Keep that working path. Matrix routines
remain the persistent cross-harness entry over ENG-93, using the real existing
private canonical Bot executor and independent activation/model permissions.

Exact reviewed sources: routine #3138 `ee08d7fc5ee39b53fed6cedb630f8d4d7a773029`;
native #3108 `2387948dc0cff71fc139c9fbd281923d58d81fca`; native shared UI follow-up
`6b9f7fab281751c5ab3c66164cfb9e3bbf9d4756`. Native real-account acceptance was on
`954de6a9216be65b5f626ae06377a42dbc7aff63`, and routine real-account acceptance
on installed Gateway `116e75dfdad066c957f2371cd9555eaa3543558a`. The newly
composed source has not been installed or live-accepted.

## Approaches and recommendation

1. **Preserve native default; offer explicit persistent scheduling (recommended).**
   A normal qualified Claude scheduling request uses native Cron. A visible
   "Persistent task" creation action chooses a Matrix routine for that creation
   flow. Both approval and delivery stay in the source Chat. This preserves the
   recent native repair while making the durable execution/model difference
   visible before effect.
2. **Ask which scheduler for every new task.** Clear choice, but adds a repeated
   step even for normal native usage. This can be a fallback for genuinely
   ambiguous requests, rather than the default interaction.
3. **Make every schedule a Matrix routine.** This would replace the working
   native experience and require routine activation even for native-session
   tasks; it does not match the owner's compatibility requirement.

The owner selected option1. Existing native jobs and routines are never
automatically migrated or duplicated.

## One creation route, enforced by the host

- The host records the creation route on the canonical request/Run from the
  authenticated owner's explicit UI choice. It is not an owner/Chat/Bot identity
  flag accepted from a model, native tool argument, environment or CLI JSON.
- The strict optional `routineCreation: "matrix"` canonical turn field is part
  of request identity/hash and persisted Run/queued snapshots. Omitted legacy
  fields preserve their existing identity and mean native for qualified Claude;
  no explicit default field is added to old request hashes. The route does not
  come from ambient mutable Chat settings. Same request UUID with another
  route conflicts. The explicit Matrix choice is attested on the same browser
  submit by the reused Clerk-session/signature infrastructure, under the
  separate `routine_creation_route` purpose and exact canonical request digest;
  no additional visible approval card is required. Existing Full Access turn
  proofs also include the revised exact request digest. Device/Terminal source
  behavior keeps its existing explicit operation-approval boundary; it cannot
  assert a browser choice through a body field.
- Ordinary qualified Claude turns default to native creation. A visible
  persistent-task action selects Matrix creation for that turn's creation flow;
  it does not silently change subsequent ordinary turns. Other harnesses keep
  their qualified existing capabilities and use the common routine entry when
  explicitly selected; this work does not implement their timer engines.
- Before any creation effect, deny native CronCreate in a Matrix creation flow
  and deny routine propose in a native creation flow. Reads, reconciliation and
  controls continue to identify the actual existing task origin and retain all
  existing authorization checks. Intentional creation of tasks using different
  engines uses separate explicit creation flows.
- Compatibility with existing exact-operation CLI: an ordinary native phase
  may offer a manually invoked Matrix proposal as an explicit persistent-task
  confirmation. A host-private per-phase creation latch is claimed before
  either engine's creation effect. Native creation first refuses a later
  Matrix creation; a pending manual Matrix choice first fences native creation.
  A manual/unattested Matrix flow always requires its real signed exact-operation
  owner decision, even when an unrelated Full Access scope exists. It is never
  automatically authorized from a model command. Keep the claim through
  cancellation/unknown to prevent alternate-engine fallback. Reads and controls
  do not claim it; due phases receive a fresh latch and no old source authority.
  The explicit browser Persistent submit remains part of immutable request
  identity; legacy owner decisions remain bound to their actual operation
  UUID/source invocation, without changing historical request hashes.
- Do not automatically fall back after timeout/unknown; reconcile the original
  native job or CLI UUID. This prevents double creation within one admitted
  flow, not semantic deduplication of every similar prompt across future turns.
- The route is routing state only. It grants no tool access, source lifetime,
  routine activation, model consent or integration permission. Retained native
  due phases do not inherit a previous Full Access lease or creation decision.
- Do not build a second capability registry/skill system. Supply the route
  contract and help text to Nima's existing discovery/skill work.

## Existing Bot target remains an execution dependency

Electron Desktop and Native Mobile keep their current trusted-device ceiling.
Their explicit persistent creation action opens this same Chat in the real
browser for an owner submit, retaining the app's draft. It does not transfer a
prompt, token, signed choice or automatic submit in the URL. Source approval
handoff shows the same canonical interaction in the browser. This is an explicit
platform limitation; native Cron remains directly usable in the app. No new
native challenge/grant protocol is introduced merely to imitate browser proof.

Reuse the existing owner-selected eligible private canonical Bot Chat. Source
Chat can offer the existing target picker inline when no valid preference
exists; the user need not navigate to the Bot Chat. Never create a hidden Bot,
guess a target, or present the source Claude Run as a Bot Run. Changing the
default does not reroute accepted work. Advanced details identify the executor
and actual approved model without making its Chat the primary workflow.

## Stable trusted origin

The immutable `routine_cli_requests.source_context` already records the real
host-admitted `chat_run` Chat/Run separately from model intent and pinned target.
`routine_cli_proposals.interaction_id` links that receipt to the actual canonical
approval. Reuse these relations; no new native process attestation is needed.

Add nullable `origin_computer_id` and `origin_request_id` to `bot_routines`, an
all-or-none constraint and composite FK to the immutable owner/Computer/request
ledger. Set only at initial activation from the exact interaction -> proposal ->
accepted receipt association, in that activation transaction. Preserve across
edits/control/archive. Do not infer old origins from name, text, timestamps,
current default or mutable `approval_id`; edits replace that approval ID.
Non-CLI and unsupported source kinds retain their current origin behavior.

Historic provenance never creates a live tool grant. The source Run and its
30-minute scope may end while the independently approved routine continues.

## Approve the same canonical interaction in the original Chat

Render an explicit origin-presentation envelope around the existing canonical
interaction. Do not create a second actionable approval, rewrite interaction
Chat/task/Run identity, or fabricate a direct Bot binding for the source Chat.

Proposed additive API (final path follows the existing route family):

| Route | Authority | Bounds / behavior |
| --- | --- | --- |
| GET `/api/chats/:chatId/routine-origin` | Current authenticated human owner; live personal/private source and exact accepted ledger link | Bounded page; safe pending decisions, attributed delivery/history references; private no-store |
| POST `/api/chats/:chatId/routine-origin/:interactionId/resolve` | Same owner plus purpose-specific signed browser decision proof; exact accepted origin link; current private canonical Bot target | Existing decision/revision schema and bodyLimit; origin mapping and canonical decision in one transaction |

Only a source Chat selector, real interaction ID, revision and decision enter
the request. The server derives canonical target, owner/Computer, source request
and approval digest. Validate both Chat lifecycles/privacy and the immutable
origin relation under the owning decision transaction. Reuse ENG-93's exact
approval/model consent checks and normal Bot continuation. Do not forward HTTP
after a separate authorization read. Duplicates resolve the same approval;
stale/changed/cross-scope requests fail without another effect. Neither the CLI
nor Full Access can activate this approval.

The builder review found an actual ingress gap: the shipped Platform
`routine-action-proof.ts` matcher covers `rcact_` exact-operation decisions,
not this new source-Chat activation endpoint. Generic signed owner routing
headers do not establish browser decision provenance; the canonical Bot
interaction endpoint currently uses owner principal authentication alone.
Do not forward through it after accepting an unproven source decision.

The minimum adapter reuses the existing Clerk-session verification, signing
keys and private proof-verification transport, adding the exact new route and
a separate purpose, `routine_origin_approval`. Its signed tuple includes the
verified owner/Computer and actual live Clerk session, source Chat selector,
canonical interaction selector, exact base revision/decision/body digest,
request correlation nonce, issued-at and expiry (at most60 seconds). The
Platform strips caller-supplied proof headers and signs only after fresh session
validation. Gateway verifies purpose, exact path/method/body/owner/Computer and
original nonce before entering the atomic origin/approval decision. An exact
duplicate is governed by the existing canonical idempotency/revision rules;
proof replay cannot authorize another interaction or modified body.

This is an adaptation for the existing human approval, not new CLI authority,
background consent, credentials, login or resources. It does not reuse the
`rcact_` source-operation purpose or the Full Access turn proof. A device label,
owner JWT or historical origin receipt cannot substitute for the real browser
session. Any shared Platform rollout requires a separate concrete version-pinned
rollout authorization after source/isolated checks.

## Deliver canonical results without running Claude again

Keep canonical routine/fire/task/Run and Bot history unchanged. A source result
is an attributed, server-authored receipt with a safe immutable text projection
and canonical history reference. It does not admit a user turn, impersonate the
source Claude, advance a native checkpoint, change its provider selection or
interrupt a foreground Run. Share scheduled-task chrome while retaining
distinct native occurrence and Matrix routine/fire provenance.

The canonical fire may settle before its final assistant message commits.
Therefore materialization reads committed canonical output and uses a durable
unique delivery identity `(owner, sourceChat, routine, fire, attempt, kind)`.
Reserve that identity, append the source item, advance Chat seq/revision/unread
state, and write source outbox events atomically. Do not rely on a volatile
postcommit sink as the only delivery mechanism. Recover bounded pending
deliveries through the owned Gateway lifecycle and authorized read reconciliation;
delivery reconciliation never dispatches scheduled work. A postcommit projection
transaction avoids reversing the source/target lock order.

Failures and action-needed states use the same trusted item mechanism. Preserve
`unknown`, prior uncertain executions, and cancellation/`execution.stop:
unconfirmed`; do not claim process exit. Missing output remains unavailable,
not a synthesized success. Expired source tool scope does not hide legitimate
history or independently cancel a standing routine.

If the source is deleted, archived or shared, suppress new decisions/delivery
there, expose source-unavailable in Schedules, and preserve canonical execution
and history. Do not cancel or reroute implicitly. Canonical target/binding/grant
drift retains ENG-93's existing fail-closed behavior.

## Implementation split and acceptance

1. **Compatibility first:** actual current routine hook + native retained
   registrar failure-first test, consistent bounded physical registration,
   single initialize, exact callbacks, cancellation and phase revocation.
2. **Origin and decision/delivery backend:** additive stable origin, strict
   source-facing contracts, transactional canonical approval alias and durable
   once-only delivery. Real isolated PostgreSQL tests before product changes.
3. **Shared Chat UI and route choice:** explicit persistent creation action,
   host route gate, same-Chat approval/result/history, inline existing target
   picker, shared scheduled-task attribution across applicable Web Canvas,
   Web Desktop, Electron Desktop and mobile renderers. Compose the native UI
   follow-up explicitly; do not assume it already exists in the CLI branch.
4. **Docs and matching-version acceptance:** update existing English docs PR,
   then Dev create -> approve in source -> delayed result -> pause/duplicate/
   stale revision -> resume/new result -> archive/retained history. Independently
   prove native create/due same-Chat result/delete still works. Film the revised
   experience only after that exact source passes; the previous film is historical.

Required failures include forged/cross-owner/Computer/Chat/Bot origin, expired
or copied source grants, lost ACK, duplicate decisions/delivery/recovery, stale
revisions, edits replacing approval ID, both Chat privacy/lifecycle races,
result-before/after-settlement ordering, active foreground Chat, unavailable
output, no wrong-engine create, and no automatic alternate-engine fallback.
Mocks/protocol fixtures, isolated PostgreSQL, actual native controls and real
account acceptance remain separate evidence classes. No new resources,
background total grant, customer deployment, merge or Slack is authorized here.

## Native receipt compatibility regression

The qualified 2.1.317 runtime emits `Scheduled one-shot task <id>` in a real
CronCreate tool result. Retained-session ownership accepts that native spelling
alongside the previously supported `job` spelling. Correlation to the actual
root tool call, validated input, exact native session and admitted phase remains
mandatory; assistant prose and failed, foreign or delegated results grant no
ownership. A session-pool regression must retain the child through the native
due phase and release the one-shot job afterward. This fixture evidence does
not replace the matching Dev delayed-result gate. Existing cancellation/list
semantics and unknown historical creates remain unchanged.
