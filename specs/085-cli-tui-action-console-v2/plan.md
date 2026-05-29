# Implementation Plan: Matrix CLI TUI Action Console Follow-Up

**Branch**: `085-cli-tui-action-console-v2` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/085-cli-tui-action-console-v2/spec.md`

## Summary

Rebuild the TUI action-console follow-up as a clean stacked layer on top of `084-matrix-cli-tui-polish`. The work is additive: preserve the parent prompt-first TUI, mascot, command hints, command palette coverage, Matrix session language, and direct CLI compatibility while planning real action execution for home shortcuts, zellij-style session management, setup wizard flow, local migration preview, and honest local laptop evaluation states.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+
**Primary Dependencies**: Ink + React TUI from the 084 stack, existing sync-client CLI/gateway/session clients, zellij-backed terminal/session stack, Zod 4 validation, Vitest
**Storage**: Existing owner-readable Matrix CLI/profile/system files only; no new persistence system
**Testing**: Vitest unit/render/client tests first, parent-regression tests, local quickstart validation, root typecheck and pattern checks before PR review
**Target Platform**: Published Matrix CLI on macOS/Linux terminals, source checkout local laptops, customer/dev VPS gateways
**Project Type**: CLI package follow-up with documentation-only planning in this PR
**Performance Goals**: Home actions visibly start or report unavailable within 1 second when local state is known; backend calls use bounded waits; source-only degraded state appears within 10 seconds
**Constraints**: Preserve parent 084 UI and behavior by default; no approved removals; safe errors; explicit destructive confirmations; 80x24 and no-color readability; no direct-command regressions
**Scale/Scope**: Follow-up implementation should be split into small Graphite layers: preservation tests, action execution, session management, setup wizard/migration, docs/local validation

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Planned setup/migration uses owner-readable local configuration and skips secrets.
- **AI Is the Kernel**: PASS. Agent setup exposes configuration for existing agents; it does not add a separate kernel path.
- **Headless Core, Multi-Shell**: PASS. The TUI remains a shell over existing CLI/gateway/session capabilities.
- **Defense in Depth**: PASS WITH DESIGN REQUIREMENTS. Plan requires validated paths/inputs, bounded waits, safe errors, confirmation gates, and secret-skipping migration.
- **TDD**: PASS. Tasks require failing tests before implementation, including preservation/regression tests against the parent.
- **Worktree/PR/Greptile**: PASS. This replacement is in a manual worktree and must ship through Graphite/PR with Greptile 5/5 before merge.
- **Documentation-Driven Development**: PASS. Local evaluation and CLI docs updates are planned deliverables.

## Project Structure

### Documentation (this feature)

```text
specs/085-cli-tui-action-console-v2/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── checklists/
│   └── requirements.md
├── contracts/
│   ├── parent-preservation.md
│   ├── home-actions.md
│   ├── session-operations.md
│   └── setup-wizard.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/sync-client/
├── src/cli/
│   ├── tui/
│   │   ├── actions.ts
│   │   ├── state.ts
│   │   ├── setup/
│   │   └── views/
│   └── commands/
├── tests/
│   └── tui/
└── package.json

www/content/docs/
└── guide/
```

**Structure Decision**: Keep implementation in the published `packages/sync-client` CLI/TUI established by the 084 stack. This PR only adds the replacement specification package; code changes should come in later stacked implementation PRs.

## Complexity Tracking

No constitution violations or exceptional complexity waivers are required.

## Phase 0 Research Summary

See [research.md](./research.md). Decisions resolved: preserve-parent contract first, action execution over visual-only selection, Matrix-session language over shell-only narrowing, wizard migration preview before writes, and source-only local capability states.

## Phase 1 Design Summary

See [data-model.md](./data-model.md), [quickstart.md](./quickstart.md), and [contracts/](./contracts/). The design defines the parent preservation contract, home action contract, session operation contract, setup wizard contract, and testable local evaluation flow.

## Post-Design Constitution Check

- **Data Ownership**: PASS. Migration candidates are user-owned files and secret data is skipped.
- **Headless/Multi-Shell**: PASS. No new core coupling to the TUI.
- **Defense in Depth**: PASS. Contracts include validation, bounded waits, safe errors, confirmation, and migration safety.
- **TDD**: PASS. Tasks are test-first and explicitly require parent-regression tests.
- **Worktree/PR Discipline**: PASS. Implementation is planned as Graphite stack layers on top of 084.
