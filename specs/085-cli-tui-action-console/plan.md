# Implementation Plan: CLI TUI Action Console

**Branch**: `085-cli-tui-action-console` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/085-cli-tui-action-console/spec.md`

## Summary

Turn the Matrix CLI TUI from a visual launcher into an actionable local control surface. The implementation will build on the TUI foundation from PR #249, remove non-actionable mascot/poster art, add a quick-action home screen, wire command palette and home actions through a shared executor, add a persistent shell-session view using the existing shell client/gateway session APIs, and add a setup wizard for Codex/Claude selection plus opt-in safe local config migration. Setup completion opens or creates a shell session with a clear "setup complete" handoff.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules, Node.js 24+, React 19 for Ink TUI components
**Primary Dependencies**: `ink`, React 19, existing `@finnaai/matrix` CLI stack (`citty`, `tsx`), existing shell client, existing gateway shell/session routes, Zod 4 via `zod/v4` for any new schemas
**Storage**: Owner-controlled Matrix home files for remote setup state/imported agent config; local CLI profile/config files under `~/.matrixos/`; selected local source directories such as `~/.codex`, `~/.claude`, `~/.agent`, and `~/.agents` are read-only inputs until explicit confirmation
**Testing**: Vitest TUI render/unit tests, executor unit tests, setup-migration unit tests, shell-client tests, gateway route tests if upload/import endpoints are added, `pnpm --filter @finnaai/matrix exec tsc --noEmit`, `bun run check:patterns`
**Target Platform**: Developer/user laptops running the Matrix CLI plus customer Matrix OS VPS gateways for session and remote setup operations
**Project Type**: Multi-package CLI/TUI + gateway integration in the existing monorepo
**Performance Goals**: Home and palette interactions respond within 100ms locally; local status refresh and session list complete within 1s p95 when gateway is healthy; setup source scan completes within 2s for normal config directories; TUI render remains readable at 60/80/100 columns
**Constraints**: No raw internal errors in TUI; no silent action no-ops; no unbounded local file traversal; no copying secrets/caches by default; all external fetches retain `AbortSignal.timeout`; mutating gateway endpoints use `bodyLimit`; destructive session actions require confirmation; no new persistence outside owner-controlled files/Postgres where already used
**Scale/Scope**: First slice covers command dispatch, quick-action home, session list/create/attach/remove, setup wizard for Codex/Claude, safe config detection/import, and docs. Layout picker, rename, pane management, and richer setup providers are deferred.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Data Belongs to Its Owner**: PASS. Local config sources are read only with explicit opt-in, and remote setup/import outputs stay in owner-controlled Matrix home paths.
- **AI Is the Kernel**: PASS. The feature enables coding-agent setup but does not alter kernel routing or introduce a separate AI decision path.
- **Headless Core, Multi-Shell**: PASS. The TUI uses existing CLI/gateway/session contracts and does not couple shell-session logic to rendering components.
- **Self-Healing and Self-Expanding**: PASS. Doctor/status recovery guidance and setup result reporting are part of the scope.
- **Quality Over Shortcuts**: PASS. The plan removes decorative art in favor of real commands, state, and tests.
- **App Ecosystem**: PASS. No app sandbox or app-store behavior changes.
- **Multi-Tenancy**: PASS. Gateway-backed session/setup operations are scoped to the active authenticated profile/runtime.
- **Defense in Depth**: PASS with required gates. New mutating setup/import behavior must include auth, body limits, path validation, resource caps, safe errors, and cleanup behavior.
- **TDD**: PASS. Implementation tasks must start with failing tests for dispatch, quick actions, session view states, setup wizard state transitions, migration allowlists, and gateway-unavailable behavior.
- **Worktree/PR/Greptile**: PASS. Planning is happening in manual worktree `/home/nima/matrix-tui-action-console` on branch `085-cli-tui-action-console`.

## Project Structure

### Documentation (this feature)

```text
specs/085-cli-tui-action-console/
|--- spec.md
|--- plan.md
|--- research.md
|--- data-model.md
|--- quickstart.md
|--- checklists/
|   `--- requirements.md
`--- contracts/
    |--- tui-action-contract.md
    |--- setup-wizard-contract.md
    `--- shell-session-contract.md
```

### Source Code (repository root)

```text
packages/sync-client/src/cli/tui/
|--- actions.ts                  # Extend action registry with setup/new-session actions
|--- action-executor.ts          # Shared executor for palette and home quick actions
|--- app.tsx                     # Owns mode, selection, execution, and refresh state
|--- setup/
|   |--- detect-sources.ts       # Safe local config source scanner
|   |--- migration-plan.ts       # Allowlisted import manifest builder
|   `--- setup-runner.ts         # Executes confirmed setup steps
|--- sessions/
|   `--- session-actions.ts      # TUI adapter over existing shell client
`--- views/
    |--- HomeView.tsx            # Quick-action home, no mascot/poster art
    |--- CommandPalette.tsx
    |--- SessionsView.tsx
    |--- SetupWizardView.tsx
    |--- ActionStatusView.tsx
    `--- ConfirmActionView.tsx

packages/sync-client/src/cli/
|--- shell-client.ts             # Reuse existing list/create/delete/attach APIs
`--- commands/
    `--- shell.ts                # Existing direct command remains scriptable fallback

packages/gateway/src/shell/
|--- routes.ts                   # Existing session endpoints; add setup import endpoint only if required
`--- registry.ts                 # Existing session metadata path

packages/gateway/src/setup/
|--- coding-agent-routes.ts      # Optional remote setup/import routes
`--- coding-agent-store.ts       # Optional owner-home atomic writes for setup state/imports

packages/sync-client/tests/tui/
|--- action-executor.test.tsx
|--- home-actions.test.tsx
|--- sessions-view.test.tsx
|--- setup-wizard.test.tsx
|--- local-config-migration.test.ts
`--- command-palette.test.tsx

tests/gateway/
`--- coding-agent-setup-routes.test.ts    # Only if new gateway routes are added

www/content/docs/guide/
|--- cli-tui.mdx
`--- meta.json
```

**Structure Decision**: Keep TUI state, rendering, and local source detection in `packages/sync-client`, because this is part of the published CLI and must work on user laptops. Reuse `shell-client.ts` and existing gateway shell routes for sessions instead of adding a second session backend. Add gateway setup routes only for confirmed remote import/setup writes that cannot be represented by existing shell/session APIs. Public docs are required under `www/content/docs/guide`.

## Defense-In-Depth Design Gates

### Auth Matrix

| Surface | Operation | Auth source | Public? | Notes |
|---------|-----------|-------------|---------|-------|
| CLI TUI local | Home/palette navigation, local config scan | Local user account only | Local-only | Reads selected local paths after explicit user action |
| CLI TUI local | Login, doctor, status, whoami | Existing CLI profile/auth flow | Local-only | Must behave like direct CLI commands |
| Gateway HTTP | Shell session list/create/delete | Existing bearer token/profile resolution | No | Reuse existing `/api/terminal/sessions` client paths |
| Gateway WS | Shell session attach | Existing shell attach auth | No | TUI may hand off to existing attach flow |
| Gateway HTTP | Coding-agent setup/import, if added | Existing bearer token/profile resolution + bodyLimit | No | Owner runtime only; reject unauthenticated/import-over-limit requests |

### Input Validation

- TUI action IDs must come from the registered action list; arbitrary palette text must never be executed as a shell command.
- Quick action shortcuts map to action IDs, not command strings.
- Session names use existing shell session validation and must reject unsafe, duplicate, empty, and overlong names before gateway mutation.
- Local config source paths are fixed allowlist candidates (`~/.codex`, `~/.claude`, `~/.agent`, `~/.agents`) and resolved under the user's home. Symlinks are skipped unless a future explicit policy permits them.
- Migration file selection uses per-source allowlists, size caps, and max file counts. Secrets, tokens, caches, logs, histories, sockets, and binaries are excluded by default.
- Any setup/import payload sent to a gateway route uses Zod 4 schemas and `bodyLimit` before body parsing.

### Error Policy

- TUI-visible messages are normalized through the existing safe error pattern and capped at 240 characters.
- Raw filesystem paths, gateway responses, provider names, tokens, stack traces, zellij stderr, and internal command output are logged only where appropriate and never shown directly in the TUI.
- Gateway-unavailable, unauthenticated, cancelled, duplicate-session, and setup-partial-failure states get explicit recovery hints.

### Resource Management

- Local migration scans cap depth, file count, total bytes, and per-file bytes.
- No unbounded Map/Set state in TUI stores; lists are derived from bounded arrays.
- External gateway requests retain `AbortSignal.timeout` through existing clients.
- Temporary setup/import files are deleted after use; owner-home writes use atomic temp-and-rename.
- Session attach exits restore terminal mode and leave a reattach hint.

### Atomicity And Failure Modes

- Setup wizard separates detect, preview, confirm, execute, and finish states so no writes occur before confirmation.
- Setup execution records each step outcome. Partial success keeps completed steps visible and does not pretend the whole setup succeeded.
- Remote setup writes are atomic per config file/import manifest. Multi-file imports either write a manifest that marks partial state or roll back files created during the failed step.
- Shell session creation either returns a created session or a safe failure; attach failure after create keeps the session discoverable with a reattach hint.

## Phase 0: Research

Completed in [research.md](./research.md). All technical decisions are resolved with no remaining `NEEDS CLARIFICATION` markers.

## Phase 1: Design And Contracts

Generated artifacts:

- [data-model.md](./data-model.md)
- [contracts/tui-action-contract.md](./contracts/tui-action-contract.md)
- [contracts/setup-wizard-contract.md](./contracts/setup-wizard-contract.md)
- [contracts/shell-session-contract.md](./contracts/shell-session-contract.md)
- [quickstart.md](./quickstart.md)

## Post-Design Constitution Check

- **Data ownership**: PASS. Imported setup state and config stay in owner-controlled local/profile/runtime paths.
- **Multi-shell/headless core**: PASS. TUI consumes CLI/gateway contracts and does not become the source of truth for sessions.
- **Defense in Depth**: PASS. Auth, validation, body limits, safe errors, resource caps, and atomic writes are captured in the contracts.
- **TDD**: PASS. The quickstart and future tasks identify failing tests before implementation.
- **Documentation-driven development**: PASS. Public CLI TUI docs are an explicit deliverable.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No constitution violations require justification.
