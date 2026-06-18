# Implementation Plan: Developer Fast Path

**Branch**: `097-developer-fast-path` | **Date**: 2026-06-16 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `specs/097-developer-fast-path/spec.md`

## Summary

Refocus Matrix OS around the developer fast path: an agent-first setup prompt, a default Developer mode beside Canvas, Terminal as the primary surface, Symphony as the secondary developer app, one canonical Terminal surface, secure Matrix-managed SSH keys, no Workspace, no voice/goal-picker/consumer-app onboarding, and a warm computer pool that reduces signup-to-ready wait time while preserving user-data isolation.

## Constitution Check

| Principle | Status | Notes |
| --- | --- | --- |
| Data Belongs to Its Owner | PASS WITH REQUIRED TASKS | Warm computers must contain no user data before assignment; abandoned assigned resources must be destroyed, not reassigned; SSH private keys remain owner-controlled. |
| AI Is the Kernel | PASS | Agent-first onboarding makes existing coding agents first-class setup guides without moving ownership of credentials to Matrix. |
| Headless Core, Multi-Shell | PASS | CLI, web onboarding, Canvas, and Terminal share the same runtime and setup state. |
| Defense in Depth | PASS WITH REQUIRED TASKS | Runtime assignment, cleanup, checkout, device flow, terminal, and repository inputs require boundary validation, idempotency, caps, and safe errors. |
| TDD | PASS WITH REQUIRED TASKS | Each track below starts with failing tests or characterization tests before product changes. |
| Quality Over Shortcuts | PASS | Scope is reduced to raise quality on the developer path rather than expanding surface area. |
| Worktree/PR/Greptile | PASS | Work is planned in manual worktree `097-developer-fast-path`; implementation must ship by PR and reach Greptile 5/5. |

## Technical Context

- **Product surfaces**: platform app-shell onboarding, shell Developer mode, shell Canvas, CLI, gateway Terminal, file/preview, Symphony app.
- **Runtime model**: per-user VPS-native computers with host bundles and platform-owned provisioning/assignment.
- **Primary state**: platform-owned signup/billing/runtime assignment state; owner-controlled runtime files and database after assignment.
- **Validation gates**: `bun run typecheck`, `bun run check:patterns`, `bun run test`; `npx react-doctor@latest shell` for React shell changes; screenshot/recording evidence for onboarding UI.

## Implementation Tracks

### Track 1: Agent-First Setup Contract

Define and test the canonical copied prompt and CLI/user journey.

- Update public quickstart and in-product onboarding copy to make the agent prompt primary.
- Ensure the prompt forbids local secret scanning/upload and uses browser/device approvals.
- Make CLI login/setup guidance resume cleanly through no-account, no-runtime, payment-required, provisioning, ready, and already-ready states.
- Acceptance gate: clean-machine walkthrough reaches `matrix run -it --session setup -- gh auth login`, repo clone, and preferred coding-agent login.

### Track 2: Default Developer Mode

Add a default Developer mode beside Canvas.

- Replace cinematic first-run with a dashboard/sidebar checklist for developer setup.
- Make Developer mode the default first-run and near-term default shell mode.
- Keep Canvas as a switchable workspace and future coding canvas.
- Show setup status, copy prompt, current action, terminal launch, Symphony launch, and runtime progress.
- Open with Terminal as the primary visible surface and Symphony as the secondary developer app.
- Hide voice/Aoede, goal picker, broad integrations, and consumer onboarding from this path.
- Acceptance gate: new web signup sees Developer mode, not voice/cinematic onboarding, and can complete setup with Terminal first or switch to Canvas deliberately.

### Track 3: Single Terminal Surface

Make Terminal the one canonical terminal product surface.

- Route all terminal launch/reattach actions through one Terminal app/surface.
- Keep named or persistent sessions behind the same surface only.
- Remove terminal-like affordances from Workspace and other deprecated surfaces.
- Acceptance gate: launcher, command palette, onboarding, and docs point to one Terminal surface.

### Track 4: SSH Key Vault and Secure Git Setup

Make source access safe for long-running agents.

- Generate Matrix-specific SSH keys inside the owner runtime instead of importing local private keys.
- Authenticate GitHub separately from SSH key creation; do not rely on GitHub CLI's optional-passphrase SSH key generator for the secure path.
- Prefer repo-scoped keys where practical; otherwise clearly disclose account-level scope.
- Store private keys encrypted or locked at rest by default.
- Load keys into the remote SSH agent only after explicit user approval and for a bounded duration.
- Add explicit trusted-runtime/passwordless opt-in with recent reauth, audit logging, revoke, and rotate.
- Ensure setup prompts never ask local coding agents to scan or upload secret files.
- Acceptance gate: secure GitHub SSH setup can clone/push without private-key upload, and revoke/rotate works from Developer mode.

### Track 5: Remove Workspace From Developer MVP

Remove Workspace from the first developer product.

- Hide/remove Workspace from built-ins, Canvas window dispatch, mobile launcher, command palette, default pins, onboarding, docs, and saved restore paths.
- Add migration behavior for persisted Workspace references so users do not see broken windows.
- Keep future Symphony + multi-terminal Canvas coding model as deferred scope.
- Acceptance gate: no default path opens Workspace; old saved Workspace state degrades safely.

### Track 6: Developer Surface Pruning

Cut default product noise.

- Hide consumer apps and games from the default developer launcher/dock/sidebar.
- Keep only developer-critical surfaces: Developer mode, Canvas, Terminal, Symphony, Chat, Files, Preview/App Preview, and CLI.
- Move broad app/integration setup out of onboarding.
- Acceptance gate: new developer default shell shows only developer-critical surfaces.

### Track 7: Warm Computer Pool

Reduce signup wait with prepared unassigned computers.

- Define warm computer lifecycle: create, prepare bundle, health-check, available, assigned, expired, destroyed.
- Enforce no user identity/data/secrets before assignment.
- Assign healthy warm computers to eligible users idempotently.
- Destroy unassigned or abandoned resources after one hour, with a sweep grace period.
- Cap pool size and expose operator audit/metrics for cost control.
- Acceptance gate: warm assignment is faster than cold provisioning, empty pool falls back cleanly, abandoned resources are destroyed.

## Dependencies and Ordering

1. Track 1 can start immediately and should anchor docs and acceptance tests.
2. Track 2 should follow Track 1 so Developer mode uses the same setup contract.
3. Track 3 can proceed immediately because latest main already moves Terminal toward singleton ownership.
4. Track 4 must land before claiming the agent-first flow is secure for real repositories.
5. Tracks 5 and 6 can proceed in parallel after Developer mode surface inventory is agreed.
6. Track 7 can proceed in parallel but must complete security/resource-management review before rollout.
7. Final rollout requires an end-to-end signup test covering agent prompt, checkout, runtime readiness, SSH/GitHub setup, clone, and coding-agent launch.

## Coordination With 093 Codebase Domain Structure

The 093 domain-structure docs are directionally correct, but the full gateway migration should not run ahead of this developer-focus cut. The safe split is:

- Land 093 PR 1 first or in parallel: `ARCHITECTURE.md`, `DOMAIN.md` convention, and the `check:patterns` boundary rule. This is low-conflict and helps later work.
- Defer 093 gateway file-move waves until after Developer mode, Workspace removal, Terminal-first setup, and SSH credential design settle. Moving high-coupling files before pruning would create avoidable conflicts and may organize code that 097 removes or reshapes.
- If 093 migration starts in parallel, restrict it to low-coupling domains that 097 does not touch, such as review, voice cleanup, social, scheduling, and local observability. Do not move `workspace`, `sessions`, `apps`, `files`, `identity`, terminal/zellij-adjacent files, or onboarding routes until 097 lands.
- Re-run the gateway domain map after 097 because Workspace removal, Developer mode, SSH credential vaulting, and warm-pool assignment may change domain placement and introduce a dedicated `credentials` or `developer` domain.

Concrete instructions for coding agents are included in [spec.md](./spec.md#implementation-agent-prompt). Treat that prompt as the handoff for any agent asked to implement 097 or coordinate 093 with 097.

## Required Tests and Verification

- Platform journey tests for warm, cold, abandoned, payment-delayed, and retry states.
- CLI tests for resumable no-runtime and setup-ready states.
- Shell tests for Developer mode routing/defaults, Terminal-first layout, Symphony visibility, hidden removed surfaces, saved Workspace migration, and single Terminal launch routing.
- Gateway/shell tests ensuring Terminal remains accessible and Workspace references do not fall through to app/file routes.
- Credential tests for SSH key creation, no-private-key-upload behavior, unlock TTL, trusted-runtime opt-in, revoke, and rotate.
- Warm pool cleanup tests for one-hour abandonment, assignment race, and active-runtime protection.
- Documentation test or snapshot verifying quickstart primary path uses the copied agent prompt.
- Manual screenshot/recording of the onboarding dashboard and simplified developer shell.

## Rollout Plan

1. Ship hidden behind an operator/user cohort flag for internal developer accounts.
2. Validate a fresh signup on a disposable runtime with warm pool enabled.
3. Validate cold fallback by draining or disabling the warm pool.
4. Validate secure SSH setup using a non-production test repository and revocation/rotation.
5. Validate existing-user migration with old Workspace/default-app state.
6. Make Developer mode the default for new signups.
7. Remove old onboarding entry points after telemetry shows no active dependence.

## Open Follow-Ups

- Decide the initial warm pool size and per-region policy based on signup volume and cost ceiling.
- Decide whether consumer apps remain installed but hidden, or are removed from the shipped developer template.
- Decide whether mobile web should show the same dashboard read-only or route users to desktop/CLI for the MVP.
- Decide whether Matrix-managed SSH keys are repo-scoped by default, account-scoped only on request, or selected per project during onboarding.
