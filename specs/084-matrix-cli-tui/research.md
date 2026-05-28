# Research: Matrix CLI TUI

## Decision: Build v1 with Ink + React inside `packages/sync-client`

**Rationale**: The published CLI already lives in `packages/sync-client`, and Matrix is already TypeScript/React-heavy. Ink gives a fast path to the OpenCode-inspired UI while preserving existing citty commands and avoiding a second terminal stack.

**Alternatives considered**: OpenTUI/Solid for closer OpenCode internals, rejected for added stack risk; zellij-native UI, rejected because Matrix needs a portable CLI control surface above zellij.

## Decision: Bare interactive `matrix` opens TUI everywhere

**Rationale**: The desired product feel is opening Matrix OS, not reading help. Explicit direct commands, help, version, and non-TTY behavior remain unchanged to protect automation.

**Alternatives considered**: Installed-only default, rejected because local source development should match production; `matrix tui` only, rejected because it weakens the main UX shift.

## Decision: Use a prompt-first, status-aware home screen

**Rationale**: The OpenCode references work because the input surface is the center of gravity. Matrix also needs immediate operational state, so status appears as a compact rail/strip with blocking actions prioritized.

**Alternatives considered**: Dashboard-first home, rejected as too heavy for daily launch; empty prompt-only home, rejected because Matrix must show auth, gateway, sync, and active work state.

## Decision: Add a shared action registry

**Rationale**: The command surface is large. A registry provides one source for palette search, keyboard shortcuts, help text, command coverage tests, destructive-action metadata, and later docs generation.

**Alternatives considered**: Hard-coded per-view actions, rejected because coverage would drift; shelling out to direct commands, rejected because interactive flows need richer state and safe confirmations.

## Decision: Keep zellij hidden behind Matrix sessions

**Rationale**: Zellij remains the proven runtime substrate. The TUI should expose Matrix-level sessions, projects, agents, tasks, and reviews, with native zellij attach details available only when useful.

**Alternatives considered**: Embed a full terminal emulator in Ink, rejected for v1 complexity; replace zellij, rejected because existing gateway/session work is already zellij-backed.

## Decision: Use existing gateway and daemon surfaces before adding APIs

**Rationale**: The TUI should be a shell renderer over current Matrix capabilities. Existing profile/auth, daemon IPC, shell clients, workspace routes, and main `/ws` kernel stream cover the first version.

**Alternatives considered**: Add a dedicated TUI backend endpoint, rejected unless implementation discovers a specific missing read/flow that cannot be composed safely.

## Decision: Store only client preferences locally

**Rationale**: Profiles, auth, sync config, and runtime state already have owners. TUI-specific defaults should be owner-readable and non-secret; native writeback should use explicit adapters and avoid whole-file symlinks.

**Alternatives considered**: Store all TUI state on the gateway, rejected as unnecessary; symlink vendor config wholesale, rejected because it can leak or overwrite unrelated user settings and secrets.

## Decision: Require bounded calls and generic user-facing errors

**Rationale**: The TUI aggregates many systems, so partial failure is normal. Every fetch, daemon request, and attach/setup action must have timeouts and safe messages to avoid hangs or internal leakage.

**Alternatives considered**: Let underlying commands print raw errors, rejected because the TUI is a user-facing shell and must preserve defense-in-depth expectations.
