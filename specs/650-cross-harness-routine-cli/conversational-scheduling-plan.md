# Conversational scheduling implementation plan

> **For agentic workers:** use the existing Trellis implement/check dispatch and failure-first workflow; main owns coordination, specs, commits, rollout and final delivery. Do not create another Trellis task.

**Goal:** Remove the scheduling creation button and use the actual admitted Chat scheduling capability while preserving source-Chat approval/results.

**Architecture:** Existing registered adapters own route authority. Claude new creation stays native; supported nonnative Chat exposes the current fixed routine CLI via its existing tool/broker. The canonical ENG-93 backend, immutable request identity, source authorization and origin projection are reused.

**Tech Stack:** TypeScript/Node24, existing Hono/React/Next/React Native/Vitest, owner Postgres/Kysely, pnpm10.33.4.

**Spec:** `specs/650-cross-harness-routine-cli/conversational-scheduling-design.md`

## Global constraints

- Parent source `6ea9a385bb9ec3d211a1cd95d8666ae74d71b2e2`; independent worktree/stacked Draft. Do not mutate parent/A/main.
- Tests fail for missing behavior before implementation. Use Node24 and pinned pnpm10.33.4; no new dependencies or lockfile changes.
- No model-supplied identity, source capability or scheduler authority; no crontab/manage_cron/direct writes/new scheduler/MCP.
- Keep approval, background model and integrations separate. No implicit source-grant renewal or default Bot creation.
- No engine fallback or automatic mutation retry after unknown/cancel. Read existing UUID and control with current revision.
- OpenCode native adaptation stays deferred. Fixture/native component evidence does not qualify a real account or all providers.
- Web Canvas/Web Desktop/Electron/Web Mobile/Native Mobile remove the visible control; existing approval handoff limitations remain explicit.
- Separate site-doc PR/update, exact Dev build/acceptance and full-Chat English video are required deliverables.

## Review focus

- Legacy explicit Matrix input must not create a native job or bypass Claude-native routing; accepted historical hashes and receipts remain stable.
- A provider/model label is not scheduling capability or source identity; managed ChatGPT and native Codex remain distinct.
- Aborted/unknown creation, stale revision and repeated UUID do not produce another engine/task or overwrite history.
- Removing creation UI must not remove actual pending approval browser handoff, source result/history, drafts or source scope fences.
- Missing target/current source/model consent must fail clearly without silently creating a Bot, broadening authorization or declaring activation.

## Task 1 — Remove creation controls, preserve source-Chat presentation

**Files:** Web ChatApp; shared PersistentTaskControl/selection hook exports; Electron SourceChatRoutines; NativeSourceChatRoutines; shared/mobile Schedules empty copy; their existing UI/shell/mobile/E2E tests.

- [ ] Replace old button-driven expectations with failing no-button/natural-language-submit tests; verify ordinary requests carry no routineCreation flag.
- [ ] Verify pending canonical approval browser handoff, result/history and current private-scope checks remain visible and functional.
- [ ] Remove obsolete button/hook wiring and exports where unused; preserve historical transport DTO/hash readers.
- [ ] Run affected Web/Electron/shared and Native Mobile checks; record exact Red/Green and any environment limitations.

## Task 2 — Enforce actual source scheduling route and conversational tool guidance

**Files:** `chat/routine-chat-source.ts`, `routine-creation-latch.ts`, `claude-routine-execution.ts`/native policy only where needed; focused internal policy extraction if required; `managed-pi-system-prompt.ts`; existing routine tool descriptions/help; gateway/contract/real-PG tests.

- [ ] Add failing tests that ordinary Claude denies routine propose before native creation, including legacy Matrix context; allow authorized existing routine reads/controls.
- [ ] Prove real native CronCreate/List/Delete and retained due routing remain available; unavailable native setup does not fall back to a routine.
- [ ] Add no-field nonnative source/broker/CLI tests retaining exact owner operation authorization and independent canonical activation; unknown/cancel and cross-scope negatives stay denied.
- [ ] Implement the minimum host policy from actual admitted adapter facts. Unknown capability/source remains unavailable; no public/model route field or duplicate capability registry.
- [ ] Keep historical request hashes, proof readers, accepted duplicate/unknown reconciliation and queued contexts stable. A legacy explicit intent cannot switch engines.
- [ ] Update tool/system prompt/CLI help through existing Nima seams: conversational intent, proposal/pending approval, same-Chat results, original UUID/revision handling; no new skill/catalog service.
- [ ] Run focused tests, real isolated Postgres lane, typecheck/pattern/lint checks and preserve test evidence.

## Task 3 — Review, document, build and live acceptance

- [ ] Independently review combined changes/spec compliance, fix findings, run required affected tests and record remaining unrelated gates.
- [ ] Update interface/coexistence/source docs and the existing separate English site-doc worktree/PR; preserve historical acceptance as historical.
- [ ] Commit/push isolated stacked Draft(s), freeze source and verify exact PR head/base; request review without merging.
- [ ] Official version-pinned immutable host-bundle build/register-only publish; independently check archive checksum/native smoke and no channel/fleet rollout.
- [ ] Update only Dev and verify release metadata/running source/services/local health. Start a new matching native QA renderer only if needed; preserve old runtime/profile.
- [ ] Real ordinary managed ChatGPT conversation -> actual CLI proposal -> review in same Chat -> delayed result -> pause/wait/resume/new result -> duplicate/stale -> archive/retained history. Verify actual worker/tool/CLI receipts; never count mocks as this pass.
- [ ] Independently verify ordinary Claude native reminder creation/delayed delivery/cleanup with no Matrix creation. Respect existing account/permission boundaries.
- [ ] Only after real acceptance, produce updated English entire-Chat demo via product-demo-video, retain prior media, and deliver exact source/dependency/interface/test/live/video evidence for C.
