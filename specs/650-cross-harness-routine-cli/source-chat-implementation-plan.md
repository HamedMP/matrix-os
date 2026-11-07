# Source Chat Routine Flow Implementation Plan

The user-facing creation control and explicit route selection in this historical plan were superseded by the [conversational scheduling implementation plan](./conversational-scheduling-plan.md). The source-Chat approval/delivery interfaces and legacy request identity remain part of the current implementation.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Trellis auto dispatch is the owner's preserved execution method.

**Goal:** Preserve native Claude scheduling by default and offer explicitly selected durable routines whose review and results stay in the originating Chat.

**Architecture:** Keep ENG-93's real canonical Bot execution unchanged. Derive stable origins from accepted CLI receipts, expose the same canonical human interaction through a verified source alias, and append durable attributed result receipts without a new Claude turn. Persist and attest the per-turn Matrix creation choice so the native and routine creation gates cannot both accept one flow.

**Tech Stack:** TypeScript, Zod4, Hono, Kysely/Postgres, existing Platform Clerk/HMAC proof transport, React shared UI, Vitest. Pinned pnpm10.33.4, Node24+.

**Spec:** `source-chat-and-native-coexistence-design.md` (owner approved2026-11-06); `native-scheduler-compatibility.md`.

## Global Constraints

- No new Bot, scheduler, MCP service, capability registry, account, key or paid resource.
- Existing private canonical Bot binding, human activation, model task consent and integration checks remain independent.
- No model identity/target override, source capability inheritance, execution replay or unknown-to-fallback conversion.
- Current Dev/Platform remain unchanged until matching source is built and applicable concrete rollout authorization exists.
- Failure-first tests; exact UUID/revision and uncertainty semantics; English public artifacts.
- No direct edits to existing source worktrees, merge, customer rollout, Slack or background total grant.

## Review Focus

- A fire settles before final assistant commit: deliver committed output once, never synthesize completion text.
- Source becomes shared/archived/deleted during approval or projection: no new private payload leak or implicit execution cancellation.
- A queued/retried turn changes creation choice: retain exact original hash/snapshot, reject changed intent.
- Background receipt arrives during foreground Claude work: preserve native checkpoint, selection, active Run and user-input identity.
- Content edits replace approval_id: retain the stable original source reference and history.

## Task1: Existing native wait compatibility

**Files:** `packages/gateway/src/chat/claude-native-session-control.ts`; `tests/gateway/claude-native-routine-wait.test.ts`.

- [x] Reproduce actual current hook/retained registrar rejection before implementation (5fail/7pass).
- [x] Use the shared1830-second upper bound in schema and physical native Bash registration; keep singleinitialize, Prompt120/guard10/shortACK and revocation.
- [x] Independent161/161 regressions, Gatewaytypes/lint/patterns/diff pass; actualARM64 ACK-only/no-model spike.
- [x] Commit5640d8058d0 on isolated composition405edcec9da. No Dev/x64/continuous30-minute/live qualification claimed.

## Task2: Stable origin, canonical decision and durable delivery

**Ownership:** Backend worker owns new `packages/contracts/src/routine-chat-origin.ts`, its root export, stored receipt part in `canonical-chat.ts`; `packages/gateway/src/bots/routine-chat-origin*.ts`, migration/database types/repository and activation integration; narrow canonical interaction transaction extraction; new `chat/routine-receipt-repository.ts` and delegate in ChatRepository/records; backend tests. Do not edit Platform, turn/queue admission, public Chat routes or renderer files. Main owns startup/server composition.

**Interfaces:** Publish strict `RoutineChatOriginViewSchema` with bounded pending envelopes `{sourceChatId, anchorMessageId, interaction}` around unchanged canonical interactions; `RoutineChatReceiptPartSchema` with `type:"routine_receipt"`, actual routine/fire/attempt/status, scheduled time and canonical history/message references. Keep receipt metadata server-stored only and exclude it from accepted user input. Expose `createRoutineChatOriginService(deps)` with `read(ownerId,chatId)`, `resolve(ownerId,chatId,interactionId,request,verifiedDecision)`, `reconcile(ownerId,chatId)` and owned `start/close` lifecycle as needed. Export real types early for neighboring workers. A proof value is a non-public result of the actual verifier, not a caller JSON boolean.

- [ ] Add real isolated-Postgres tests: exact accepted ledger/proposal/interaction origin; wrong owner/Computer/Chat/Bot; stale/duplicate decisions; changed approval_id; final-output ordering; once-only projection/recovery; source privacy race and busy foreground Chat. Execute meaningful Reds before implementation.
- [ ] Add all-or-none originComputer/originRequest FK columns (next ordered migration), set within initial canonical activation transaction, preserve on revision/control/archive. Do not guess/backfill old origins.
- [ ] Resolve source alias and both private Chat scopes inside the existing canonical decision transaction. Keep canonical IDs, digest/model checks and continuation; no second approval or copied Bot identity.
- [ ] Append one committed system/attributed receipt containing safe text plus typed provenance, no turn/run reference impersonation. Reserve unique delivery identity and append source seq/revision/unread/outbox atomically under a source-only write lock.
- [ ] Recover bounded pending projections after canonical output commits through the owned Gateway lifecycle and authorized read reconciliation. No provider/I/O under transaction, reverse lock ordering, volatile-only delivery or scheduled execution retry.
- [ ] Run scoped real-PG/contract/interaction/control/delivery suites, types and lint; report actual API/dependency wiring for main.

## Task3: Trusted creation route and source approval ingress

**Ownership:** Policy/proof worker owns `packages/contracts/src/canonical-chat-api.ts`; new dedicated proof contract module (ask backend worker to add root export); `gateway/chat/agent-context.ts`, `turn-admission*.ts`, `queue-repository.ts`, provider input mapping, native CronCreate/routine propose host guards; new Gateway origin route/proof-client factories; Platform purpose/path/signature/proof routes and proxy wiring. Main owns `gateway/src/server.ts` and `startup/bots.ts`. Coordinate any additional shared existing file before edit.

**Interfaces:** Optional strict `routineCreation:"matrix"` on canonical create/queue turn. Omitted legacy input retains byte-identical old identity/hash and native default for qualified ordinary Claude. Explicit Matrix route participates in canonical identity, accepted Run context and queue/claim snapshot. Two non-interchangeable signed purposes: `routine_creation_route` for the exact canonical request and `routine_origin_approval` for exact source path/interaction/revision/decision digest. Reuse real Clerk session and existing signing/verification transport, max60sec, caller header stripping and exact machine/slot/owner checks. Source POST and GET paths follow the reviewed design. Route factory requires the real service and verifier at registration.

- [ ] Fail first: sameUUID/differentroute, queueclaim/restart preservation, unsigned/copied/device/expired/wrongpurpose/crossscope proof, directGateway and spoofheaders; real production Hono/proof verifiers rather than boolean fixtures.
- [ ] Persist browser-attested Matrix choice on the exact admitted creation flow; fresh ordinary turns and native due phases do not inherit it. Existing device/Terminal exact-operation approval semantics remain separate.
- [ ] Gate only creation before effect: native CronCreate versus routine propose by actual host flow. Keep native List/Delete and routine reads/controls tied to existing origin; retain old native jobs through a later Matrix flow. Unknown never launches the alternate engine.
- [ ] Wire narrow source-origin read/resolve ingress with bodyLimit/no-store, safe errors and actual proof verification, then canonical source service. No HTTP read-then-forward authorization gap.
- [ ] Run contract/turn/queue/native/routine and actual Platform proof/Hono regressions plus affected types/lint. Document any shared Platform rollout needed; do not deploy.

## Task4: Shared source-Chat presentation

**Ownership:** UI worker owns new `packages/ui/src/chat/RoutineOrigin*.tsx`/client/hook, source receipt derivation/rendering, shared exports; Web shell/Electron/mobile Chat creation/requests/rendering and existing target picker reuse; UI/renderer tests. Do not edit contracts/Backend/Platform files owned above. Main owns final cross-worker composition.

**Interfaces:** Consume Task2 strict origin/receipt contracts and Task3 `routineCreation`. Reuse `InteractionCard`/`RoutineApprovalDetails` with explicit canonical interaction identity; never fake BotMessageStateContext. Expose "Persistent task" only in eligible ordinary Chat creation flow, native default otherwise, with an inline existing private Bot target picker if missing. The selected route is sent on that submit only, not ambient mutable authority.

- [ ] Fail first: same-Chat canonical approval, stale/duplicate/lostresponse state; safe source result attribution and history; pending state while streaming; reload/switch/pagination/unread; forged text/metadata negatives; submitroute/reset/crossidentity safeguards.
- [ ] Compose native shared scheduled-message chrome from exact6b9 followup selectively with tests first; do not import its unrelated branch ancestry or discard existing FullAccess client behavior. Native and routine IDs remain distinct.
- [ ] Render original-Chat approval using the actual source endpoint. Result receipts use normal persisted source Chat seq with the shared scheduled-task label/time and actual model/executor attribution; no user impersonation or extra inference.
- [ ] Keep applicable Web Canvas/Web Desktop/Electron Desktop/mobile equivalent actions/states/errors. Link Schedules to actual source and canonical execution history, with safe source-unavailable state. No automatic Bot creation or provider authorization.
- [ ] Run UI/renderer/request suites and types/lint; report actual entrypoints for main wiring and preserve dirty work by other workers.

## Task5: Composition, independent check and delivery

- [ ] Main wires real origin service/proof routes, projection lifecycle/drain and both host gates at dependency registration; no new global service locator or daemon. Add actual published CLI -> canonical approval -> source read/decision -> committed result fixture integration and realPG races; never label fixture account success.
- [ ] Independent Trellis check; fix meaningful findings; run root types/patterns/test gates and separate inherited failures from new ones. Commit explicit scoped paths only; no gitaddall across workers.
- [ ] Split Draft PRs around proof/policy, origin/delivery backend and shared presentation; record exact dependency commits and English invariants/tests/remaining gates. Update existing docs PR without duplicating Nima discovery.
- [ ] Build exact reviewed artifacts and update authorized Dev only after source checks; any shared Platform rollout needs its own version-pinned authorization. Real routine activation remains a human step. Repeat native same-Chat and durable source-Chat lifecycles before claiming acceptance or replacing the historical video.

Self-review: every approved design requirement maps to a task. The explicit
owner route decision is already approved; implementation detail/proof reuse
does not require another product-choice prompt. New account grants, shared
rollout and real routine activation retain their independent authorization.
