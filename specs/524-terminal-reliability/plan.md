# Implementation Plan: Terminal Reliability

**Branch**: `codex/524-terminal-reliability` | **Date**: 2026-09-17 | **Spec**: [spec.md](spec.md)

## Summary

Audit Terminal against a single behavior contract, reproduce each failure at its actual boundary, and land narrow repairs with independent evidence. Preserve workspace/tab identity and current authorization. PR #1736 is the first bounded repair, covering legitimate startup replies exceeding raw pending-frame limits startup snapshot row alignment, and the Human Review scrolling follow-up (one history rail, trackpad edge access, and unused-grid clipping). It does not establish completion of the broader audit.

## Technical Context

**Language/Version**: Node.js 24+, strict TypeScript, React 19.  
**Primary Dependencies**: Hono WebSockets, xterm, shared UI, Zellij, Linux user systemd, Electron.  
**Storage**: Existing owner-controlled terminal workspace metadata, runtime state and Postgres-backed authorization; no new persistence engine or schema proposed.  
**Testing**: Vitest; actual Unix sockets; instrumented Electron and Web clients against a disposable VPS.  
**Target Platform**: Linux VPS; Web Canvas, Web Desktop, Electron Desktop; existing Web Mobile/Native Mobile and CLI/agent capabilities.  
**Performance Goals**: Spec success trials; compare attach-to-ready and reconnect duration under recorded conditions instead of inventing a universal latency SLA.  
**Constraints**: Keep current owner/project checks, writer lease, bounded replay and input, durable processes, protocol ordering and content-free diagnostics.  
**Scale/Scope**: One terminal and multiple simultaneous viewers, multiple tabs/workspaces, slow admission, bounded bursts, runtime update continuity. Fleet rollout is outside this plan's initial execution authorization.

## Constitution Check

- Data ownership: all tests use synthetic sessions in an authorized disposable VPS. No customer session deletion or content capture.
- Headless core: correctness resides in gateway/runtime contracts; renderers share semantics.
- Security: account, reference, Chat binding, project, attachment mode, and live writer checks stay authoritative. See contracts/terminal-reliability.md.
- Resource limits: retain bounded queues, output history, subscriber lifecycle and shutdown cleanup. Measure overload independently from legitimate bursts.
- TDD: each defect requires a failing reproduction before a narrow repair. Existing passing tests do not substitute for the incident reproduction.
- Worktree/PR: isolated worktrees and draft PRs; exact-head review and Human Review before landing. No merge or fleet deployment is implied.
- Documentation: update relevant public-safe developer contracts. Deliver a separate documentation PR in `FinnaAI/matrix-os-site` under `content/docs/` for verified Terminal connection, ownership, and recovery behavior. Keep unverified audit expectations out of user-facing guarantees.

Post-design check: no new owner, storage, protocol endpoint, or unbounded resource is introduced by the first repair. Broader stages are diagnostic until a separate failing reproduction identifies a change.

## Project Structure

- `specs/524-terminal-reliability/`: behavior, evidence, state model, contracts, test procedure.
- `packages/terminal-runtime/src/`: workspace/tab runtime, socket attach, input admission, replay, process supervision.
- `packages/gateway/src/server.ts`, `shell/workspace-routes.ts`, `terminal-live-ownership.ts`: principal and project checks, bridge, viewer authority.
- `packages/ui/src/terminal/`: shared terminal rendering, dimensions, input and presentation.
- `desktop/src/renderer/src/lib/shell-socket.ts` and corresponding Web/mobile clients: connection lifecycle.
- `tests/terminal-runtime/`, `tests/gateway/`, `tests/shell/`, `tests/desktop/`: focused regression coverage.

## Phase 0 — Reconcile contracts and establish evidence

1. Mark superseded details in older specs as historical in research.md; do not resurrect scalar session APIs or multi-writer graphical input.
2. Record client SHA, installed and running VPS version, runtime generation, surface, terminal reference, viewer and event times for every trial. Keep identifiers private.
3. Distinguish transport open, attached, input authority, render readiness, output replay and process health. Classify each symptom against these boundaries.
4. Preserve the demonstrated 32/33/259-frame baseline and binary/order/security controls. Investigate flicker separately if it survives the disconnect repair.

## Phase 1 — First repair and review environment

PR #1736 introduces a shared bounded ordered queue at gateway and runtime socket boundaries. Coalesce adjacent same-reference input only, without crossing control or encoding boundaries. Recheck existing authorization before each forwarded batch. Preserve 32 outstanding batches, 1 MiB serialized storage and 64 KiB merged input limit. Drop queued work on disconnect/error; release a viewer whose native attachment completes after close.

The implementation already exists for evaluation; it remains subject to this contract and exact-head live verification. Do not treat writing this plan as retroactive proof that all acceptance criteria passed.

## Phase 2 — Complete the reliability audit in bounded slices

| Slice | Required failing evidence before editing | Regression boundary |
|---|---|---|
| Startup and first render | New-terminal event timeline and exact reply bytes/counts | Commands, full-screen applications, input order and current authority |
| Replay and visibility | Output sequence/snapshot acknowledgement vs displayed buffer | Bounded history, idle/hidden clients and no duplicate output |
| Dimensions and scrolling | Canonical rows/cols vs measured viewport before/after attach | Bottom line, readability, explicit pan, DPI and Canvas zoom |
| Recovery and lifecycle | Same reference/process across interruption or restart | No auto-creation, no process kill on detach, explicit termination only |
| Multi-device and upgrade | Writer/observer transitions and old-process input after two updates | Text/binary input, agent authorization, observe reconnect and project isolation |
| Everyday interactions | Paste/typing/shortcuts/theme/link/provider-setup trial failure | Existing UI semantics and runtime selection fencing |

Produce a separate narrow PR when a new cause requires independent changes. Do not rewrite the terminal architecture merely because several symptoms were reported together.

## Verification and delivery

Use quickstart.md and the surface matrix. For each requirement record automated evidence, real runtime evidence, and Human Review separately. Capture content-free event counts and app-only screenshots. Check exact SHA and installed/running version after deployment. Preserve the Preview and matching Electron for user testing. Record all failed baseline tests rather than declaring a green suite. Land only after authorized Human Review and repository review gates; production promotion requires separate explicit authorization.

Planned documentation deliverable: a separate `FinnaAI/matrix-os-site` PR updating the canonical Terminal guide with verified connection/recovery behavior and actionable user steps, reviewed alongside the corresponding implementation slices.
