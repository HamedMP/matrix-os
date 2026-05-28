# Implementation Plan: Matrix CLI TUI

**Branch**: `084-matrix-cli-tui` | **Date**: 2026-05-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/084-matrix-cli-tui/spec.md`

## Summary

Build the Matrix CLI TUI as the default interactive experience for `matrix`, `matrixos`, and `mos`. The published CLI gains a prompt-first, status-aware terminal cockpit with a command palette, first-run setup, safe account/sync/instance flows, zellij-backed shell/session management, and workspace/coding controls while preserving every direct command for scripts and power users.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+  
**Primary Dependencies**: citty, Ink + React, ws, Zod 4, existing sync-client/gateway command clients  
**Storage**: Existing `~/.matrixos` profile/auth/config files plus owner-readable TUI preferences; no new database  
**Testing**: Vitest unit/render/client tests, existing gateway/session tests, root typecheck and pattern checks  
**Target Platform**: Published Matrix CLI on macOS/Linux terminals, local source development, customer/dev VPS gateways  
**Project Type**: CLI package with gateway integrations and public docs  
**Performance Goals**: First paint within 1 second when local state is readable; status refresh completes within bounded timeouts; session attach begins within existing shell attach latency  
**Constraints**: Preserve direct CLI command compatibility; no unbounded fetch/daemon/WebSocket waits; safe errors only; 80x24 and no-color support; no new persistence system  
**Scale/Scope**: Full current Matrix CLI command-family surface, implemented as stacked PR milestones to satisfy PR size limits

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. TUI state is owner-readable under existing CLI/home configuration locations; no platform-owned persistence or new database.
- **AI Is the Kernel**: PASS. Prompt and agent flows route through existing gateway/kernel/session paths rather than adding a separate backend brain.
- **Headless Core, Multi-Shell**: PASS. CLI is a shell renderer over the gateway/kernel and zellij/session substrate; core behavior remains headless.
- **Defense in Depth**: PASS WITH DESIGN REQUIREMENTS. Plan requires auth reuse, input validation, bounded calls, safe client errors, destructive confirmations, and WebSocket/client contracts.
- **TDD**: PASS. Test-first implementation is required for launch routing, registry coverage, status aggregation, rendering, clients, and destructive confirmations.
- **Worktree/PR/Greptile**: PASS. Work is in a manual feature worktree and should ship as stacked PRs with Greptile 5/5 before merge.
- **Documentation-Driven Development**: PASS. Public CLI docs updates are included.

## Project Structure

### Documentation (this feature)

```text
specs/084-matrix-cli-tui/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/
│   ├── action-registry.md
│   ├── cli-launch.md
│   ├── gateway-clients.md
│   └── tui-flows.md
└── tasks.md
```

### Source Code (repository root)

```text
packages/sync-client/
├── src/cli/
│   ├── index.ts
│   ├── tui/
│   │   ├── app.tsx
│   │   ├── actions.ts
│   │   ├── clients.ts
│   │   ├── status.ts
│   │   ├── state.ts
│   │   └── views/
│   └── commands/
├── tests/
│   ├── unit/
│   └── tui/
└── package.json

www/content/docs/guide/cli.mdx
```

**Structure Decision**: Implement the production TUI inside the published `packages/sync-client` CLI package. Reuse the root `bin/tui` prototype only as reference and avoid making the private repo-root CLI the source of truth.

## Complexity Tracking

No constitution violations or exceptional complexity waivers are required.

## Phase 0 Research Summary

See [research.md](./research.md). Decisions resolved: Ink + React for v1, prompt-first home, explicit launch routing, shared action registry, bounded status aggregation, zellij as hidden substrate, gateway `/ws` for prompt streaming, and owner-readable preference storage.

## Phase 1 Design Summary

See [data-model.md](./data-model.md) and [contracts/](./contracts/). The design defines CLI/TUI runtime entities, command/action contracts, launch behavior, gateway client behavior, destructive-confirmation rules, and user flow contracts.

## Post-Design Constitution Check

- **Data Ownership**: PASS. TUI preference data is owner-readable and secrets remain in existing auth stores.
- **Headless/Multi-Shell**: PASS. No core coupling to Ink; CLI uses existing gateway and session surfaces.
- **Defense in Depth**: PASS. Contracts require auth propagation, input validation, timeouts, safe errors, no wildcard new trust boundary, and confirmation gates.
- **TDD**: PASS. Quickstart and later tasks must start with failing tests before implementation.
- **Worktree/PR Discipline**: PASS. Feature is scoped for stacked PRs.
