# Specification Quality Checklist: Conversational Recipe Bots

**Purpose**: Validate the specification before the later spike.
**Created**: 2026-09-26
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Product specification focuses on user value; implementation hypotheses are in a companion technical design.
- [x] Conversational setup has no required form fields; external provider consent is explicitly distinguished.
- [x] Stable rabbit identity, direct conversations, group participants, and progressive integrations are explicit.
- [x] Mandatory scenarios, requirements, entities, and measurable success criteria are complete.

## Requirement Completeness

- [x] No unresolved clarification placeholders; assumptions and phase boundaries are stated.
- [x] Requirements are testable; success criteria describe observable outcomes.
- [x] Acceptance scenarios include ordinary, interrupted, declined, duplicate, revoked, and unauthorized paths.
- [x] Scope distinguishes complete-product ambition from the staged feasibility program, and delivery milestones order the release.
- [x] All existing catalogue entries have a capability mapping and a concrete proposed task with an observable result; a proposed launch set awaits owner confirmation.
- [x] Surface parity names Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and Native Mobile.
- [x] Bot history, private memory, group membership, account connection, and authority are distinct.
- [x] Memory kinds, scopes, provenance, retrieval bounds, and forgetting are specified; external content cannot create standing memory without owner confirmation.
- [x] An authoritative read-only authority view is distinguished from both model narration and configuration forms.

## Architecture and Execution Readiness

- [x] Technical companion includes auth matrix, input validation, error policy, startup/shutdown wiring, failure modes, resource bounds, and third-party data flow.
- [x] Bot execution extends the existing scope runtime (no-network workload, broker-only model and tool access) instead of adding a parallel service; direct and group runs share one admission path.
- [x] Group bots follow the one-run-per-Chat queue and guest collaboration AI permissions (PR #1941).
- [x] Funded-route concurrency, vision-model cost, and graphical-session capacity are explicit.
- [x] A runtime decision record compares Pi, Hermes, and the Claude Agent SDK on stated criteria.
- [x] Source of truth, multi-write transactions, file/database partial failure, and uncertain external effects are explicit.
- [x] No new production runtime, dependency, endpoint, or deployment is claimed by this spec PR.
- [x] Undocumented Pi assumptions require a later pinned-version probe; no successful spike is claimed.
- [x] The spike program includes a real visual-desktop action, actual test-account integration flow, two-bot group handoff, restart recovery, and negative authority tests, split into stages with separate timeboxes.
- [x] Per-milestone go/revise/no-go criteria, stage timeboxes, spend preflight, evidence retention, and cleanup are specified; surface parity is qualified during implementation, not in the spike.
- [x] Separate public documentation PR is an explicit later deliverable.

## Requirement Traceability

| Requirements | Acceptance evidence |
|---|---|
| FR-001-003 | Story 1; Spike A (S1) and creation/reopen/correction trials |
| FR-004-005 | Story 2; Spike A (S2) plus cancel/duplicate/forged/revoked connection cases |
| FR-006-007 | Story 3; Spike B (S4) plus private-context, guest AI permission, and cross-owner negative tests |
| FR-008-010 | Story 4; Spike C (S3) and Spike A (S5) plus takeover, approvals, and uncertain-effect recovery |
| FR-011-012 | Story 5; scoped-memory and memory-injection tests in Spike A; export/forget/learning/routine qualification in production follow-up |
| FR-013 | Recipe map with concrete tasks and proposed launch set; launch-set validation before M1; later per-entry live acceptance |
| FR-014 | Implementation surface qualification per milestone; pending surface evidence blocks production release |
| FR-015 | Migration preservation scenarios in production follow-up; spike leaves existing harnesses untouched |
| FR-016 | Stories 2/4 edge cases; failure-injection matrix |
| FR-017 | Authority view checks in Spike A and failure cases 6-7; SC-008 |
| FR-018 | Spike B funded-route run and failure case 14; SC-009 |
| FR-019 | Channel-independent data model review during M1 planning; channel hosting in M5 |

## Review Result

Specification is ready for GitHub review and subsequent spike planning. Checked items assess document completeness, not implementation or runtime acceptance. All spike execution and product acceptance remain unperformed. GitHub publication, owner scope acceptance, and a follow-up execution task precede the spike.

## Local Publication Checks

Initial publication:

- Passed: relative Markdown link checks, sequential FR/SC identifiers, feature pointer, and all 71 source inspiration names mapped. Source count confirms 53 entries suggest routines.
- Passed: `git diff --check`; `bun run check:patterns` reported zero violations and five existing warning categories. No production source files changed.
- Not completed: `bun run typecheck` and `bun run test` stopped in the prerequisite observability build because this worktree has no installed dependencies; local Node is 22 rather than the required 24+.
- Not completed: docs-contract command `pnpm exec vitest run tests/repository/site-extraction.test.ts` could not find Vitest. GitHub CI remains pending at publication.
- No SDK spike, live model call, UI implementation, or deployment was executed.

Review revision (renumbered from 535 to 536; 535 belongs to guest collaboration):

- Passed: relative Markdown link checks across all five documents; FR-001 to FR-019 and SC-001 to SC-009 are sequential; feature pointer names `specs/536-conversational-bots`.
- Passed: all 71 source inspiration names appear exactly once in the inventory, per-row routine counts match the source (53 entries suggest routines), and no scenario uses another vendor's product name.
- Passed: `git diff --check`; `bun run check:patterns` on Node 24 reported zero violations and five existing warning categories. No production source files changed.
- Code references added in this revision were checked against Matrix `5f9fc5362`: scope-runtime profile and broker protocol, shared-AI adapter eligibility, funded usage-mode reservation rejection, the single `activeRun` Chat projection, `ChatContextReceipt.tsx`, and gateway channel adapters. The Pi 0.87.1 release was confirmed with `pnpm view` on 2026-09-26.
- Not run: the docs-contract Vitest suite, because this worktree has no installed dependencies; it covers `www/`, `AGENTS.md`, and `README.md`, which this PR does not change. GitHub CI runs it.
