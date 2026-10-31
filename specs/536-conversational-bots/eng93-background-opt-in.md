# Personal ChatGPT background opt-in implementation plan

> For agentic workers: use `superpowers:executing-plans` in this existing isolated worktree. Keep an evidence ledger outside Git. Execute the approved scope without repeating account consent.

**Goal:** Allow an owner to explicitly authorize scheduled Bot work on the currently selected Computer, with background access off by default.

**Architecture:** Reuse the existing native account vault, owner/Computer binding, revisioned grant, signed peer capability, and inference permission checks. Connect remains interactive by default. A separate explicit Settings save carries the displayed account and grant revision; Main rejects stale intent before writing or advertising authority.

**Tech stack:** Existing TypeScript, Zod 4, Electron IPC, React, Vitest; no new dependencies or credential stores.

**Spec:** [ENG-93 candidate](eng93-candidate.md), [live acceptance](eng93-live-acceptance.md), and the parent task's 2026-10-30 explicit safe-wiring direction. Ticket: [ENG-93](https://linear.app/matrix-os/issue/ENG-93/enable-and-validate-recurring-tasks-on-the-launch-agent).

## Global constraints

- Default background permission is false, including a new OAuth connection and explicit reconnect.
- Native credentials stay in the existing encrypted owner vault; never copy or synthesize credentials/grants.
- Keep trusted-main-frame, owner, Computer, account, model, grant revision, cancellation, revocation, and execution-time checks.
- Preserve existing interactive-only payload compatibility; background enabling requires explicit account/revision-bound intent.
- Do not replay the already completed personal connection or fixed-text interactive run, or change its model.
- No Main deployment, other task profile changes, permission expansion, or unknown-outcome retries.
- Only the named private Preview may receive the already authorized temporary live grant, after new-source verification. Revoke background after the bounded acceptance.
- Heavy tests, builds, and video encoding remain serialized with other tasks.

## Review focus

1. A stale Settings tab must not authorize another account, Computer, owner, or revision.
2. Signed background capability must derive from the actual saved grant, never a literal true.
3. Revocation must increment revision, stop the peer, and abort in-flight work; queued stale work must fail closed.
4. Explicit reconnect defaults to interactive; ordinary peer recovery may retain a still-valid saved grant.
5. Status reads, connection completion, unsupported surfaces, and read-only users must never silently opt in.

## Task 1: Native authorization and signed capability

**Files:**
- `desktop/src/shared/chatgpt-plan-ipc.ts`
- `desktop/src/main/chatgpt-plan/service.ts`
- `tests/desktop/chatgpt-plan-background-grant.test.ts`
- Existing IPC/native roundtrip tests remain in the regression set.

**Interface:** `chatgpt-plan:set-grant` retains `runtimeSlot`, `authGeneration`, `enabled`, and `background`. Background opt-in additionally requires the displayed `accountId` and `baseRevision`. Existing false-only calls remain valid. A provided account/revision must always match current native state.

- [x] Write one failing real IPC → Main → saved vault → signed peer → inference test. Only issuer/provider HTTP is mocked; account/grant persistence and proof signing remain real.
- [x] Confirm RED from the existing background rejection, rather than fixture setup.
- [x] Accept explicit validated background intent; compare account/revision and generation again inside the serialized write. Publish the saved grant's bit and retain execution-time permission checks.
- [x] Add wrong-account/Computer/owner/revision, revocation/in-flight, reconnect-default, and stale-intent regressions, each RED→GREEN where behavior is new.
- [x] Run existing IPC/service/native roundtrip regressions; keep implicit/untrusted background rejection intact.

## Task 2: Explicit current-Computer Settings consent

**Files:**
- `packages/ui/src/agents-providers/local-chatgpt-plan-client.ts`
- `packages/ui/src/agents-providers/LocalChatgptSubscription.tsx`
- `tests/ui/local-chatgpt-background.test.tsx`
- `tests/ui/local-chatgpt-subscription.test.tsx`

**Interface:** Settings supplies the accepted status account ID and grant revision to `setGrant`. The native client continues to attach the owner/Computer session and invalidate dependent catalogs only after accepted receipts.

- [x] Write a failing actual-component test: checkbox is initially off; checking it does not grant access until an explicit save; save carries the displayed account/revision and updates accepted state.
- [x] Add an owner-only current-Computer checkbox and save action. Do not expose it for unavailable/read-only/disabled connections. Reset unsaved intent on source identity/revision changes.
- [x] Cover failed saves, late account/Computer replacement, revocation, and no automatic enable on Connect/status reads. Update old UI assertions only where the explicitly approved new control changes behavior.
- [x] Run UI and native client transport regressions, targeted strict types, and relevant pattern checks.

## Task 3: Review, matching client build, and bounded live acceptance

- [x] Review the complete delta independently and address material findings with regressions.
- [ ] Commit the verified candidate; preserve old compiled artifacts before a new exact-head client build.
- [ ] Keep the existing personal source/model and Bot. Use normal owner UI to enable the new temporary permission on `pv-3019-ec77b06f` only.
- [ ] Verify a supported fixed-text proposal → approval → durable schedule → actual due Bot execution. Pause/cancel the temporary routine; then disable background and verify the resulting revision/bit.
- [ ] Finish English `product-demo-video` footage without repeating the completed interactive run. Encode only when the shared heavy window is clear; inspect all contact sheets.
- [ ] Report exact client/Host versions and which checks are old-head, new-head, local, hosted, or still pending. Do not claim full live scheduling from the prior successful interactive response.

Public documentation follow-up remains in the existing ENG-93 site draft; do not overwrite or republish the previously interrupted site task.
