# Spec 098 Implementation Notes: Terminal Session Reliability

## Completed In This PR

### Focused-Pane Live Agent Detection

The focused Zellij pane's validated foreground command is now the primary source of truth for active terminal agent identity. Exact allowlisted command parsing recognizes Claude, Codex, OpenCode, and Pi, including supported `env` wrappers, without substring matching. Successful shell observations clear every agent-only response field, while recognized processes appear immediately even before provider hooks start.

Provider hooks remain optional enrichment. Matching non-ended snapshots can supply subtitle, action, model, strength, timestamp, and semantic visual status. Mismatched or ended snapshots are not exposed, and a recognized process without compatible enrichment is shown as running. When pane inspection is unavailable, the gateway falls back to a non-ended hook snapshot and then a persisted launch hint for at most 12 seconds.

Session-start and provider-change events clear old enrichment before accepting fields from the new event. An ended snapshot no longer derives an active visual status, so correctness does not depend on any provider emitting a session-end event.

### Sticky Visual Status

Older bundles could persist terminal `visualStatus` metadata such as `waiting` or `running` in `system/shell-sessions.json`. When a newer bundle loaded that owner metadata, the saved visual state could keep a live terminal looking stuck even after current scrollback showed newer command activity, command completion, or a quiet live shell.

The gateway now constrains how session summaries interpret that metadata. Current runtime/session existence and scrollback activity evidence drive the visible status. Durable metadata is preserved as owner data, but stale transitional states are not treated as authoritative forever. A repeated explicit `waiting` intent also refreshes its own timestamp, so a fresh waiting phase does not expire against an older waiting timestamp.

### Session Truth And Reconciliation

Gateway registry summaries now prefer live runtime existence and scrollback activity over durable UI metadata for liveness and visual status. Missing runtime sessions are reconciled to exited metadata during normal registry reads, while live runtime sessions missing metadata are adopted. Existing shell tests cover canonical session restoration, legacy PTY layout replacement, saved canonical session recreation before layout restore, active row focus without duplicate tabs, and delete-scoped pane removal.

### Stale Refresh UX And Optimistic Rollback

The shell sidebar keeps last-known terminal rows visible when refresh fails, labels them as stale, and keeps the existing refresh action available. Session UI-state patch/rollback behavior is extracted into `terminal-session-state.ts` so placement, seen-state, and visual-status optimistic updates can be tested without rendering the whole sidebar. Failed optimistic rollbacks only revert fields that still match the failed optimistic patch, preserving concurrently refreshed fields.

### Terminal Health Diagnostics

`/api/terminal/health?include=sessions` now returns coarse terminal/session counts for operator diagnosis without direct SSH access. The response includes only aggregate counts and generic failure codes; it does not expose session names, filesystem paths, provider details, or raw runtime errors.

### Coverage Expansion

Reopening a background shell now keeps the selected runtime session as the active shell even if the follow-up placement persistence request fails. The local attach/open action is treated as current UI truth, so the drawer does not roll the row back to background while the pane is visibly attached. The no-rollback path also suppresses the misleading placement-update error banner because the shell did open successfully. The regression verifies that reattach uses the existing managed session and does not issue create or delete calls.

The zellij terminal WebSocket now accepts the explicit `destroy` frame emitted by terminal pane close paths. The frame uses the existing scoped cleanup path for the attached shell bridge process instead of being rejected as an invalid message.

### Lifecycle And Canonical Reconciliation Expansion

`ShellRegistry.list()` now returns a reconciled session summary from the real registry read path, not only from isolated helper tests. Runtime/zellij session existence remains canonical for liveness. Saved metadata contributes UI preferences such as placement and status hints, while aliases and stale pane references are folded into the returned summaries.

The registry now preserves background sessions across normal list/get/list cycles that model backgrounding, reopening, and reconnecting. The adapter contract test proves those flows call `listSessions()`/attach lookup only: they do not call `createSession()` and they do not call `deleteSession()` while the runtime still lists the same live session.

Known workspace and legacy aliases collapse onto one canonical runtime session summary with a single attach command. Known legacy aliases also resolve through `get()` and `delete()`, so open/delete flows act on the canonical selected runtime session instead of rejecting before recovery. Delete removes only that canonical target and cleans aliases/references for that target.

Stale pane references are surfaced during normal `/api/terminal/sessions` reads as recoverable exited rows with coarse recovery metadata. The route-level regression uses a real `ShellRegistry` behind `createShellRoutes`, proving aliases, recoverable pane refs, and legacy delete behavior flow through the product HTTP path.

Stale pane references that point at the same missing canonical session through both an alias and the canonical name now collapse to one recoverable canonical row. The row preserves all matching references and aliases, so the read path does not emit duplicate exited sessions or lose recovery metadata for alias-only references.

Idempotent same-name rename requests also return the same decorated canonical session shape as normal reads, including aliases and references. The no-op branch does not call the adapter rename path, but it still includes registry file context when building the response.

Create adoption of an already-live runtime session now returns the same alias/reference-aware decoration as normal reads. Rename also resolves known aliases before liveness checks and adapter operations, so a rename request for a legacy or workspace alias acts on the canonical runtime session.

Rename consumes an existing alias when the canonical session is renamed to that alias name. This prevents self-referential alias metadata such as `workspace-main -> workspace-main` from being persisted while keeping pane references on the new canonical name.

## Expected User Experience

- A single session follows `Terminal → Claude → Terminal → Codex → Terminal` within successive five-second refreshes, changing logos and compact card height without retaining the prior provider's metadata.
- Manually launched agents and first-run/authentication screens receive the correct agent identity before hook metadata exists.
- In multi-pane sessions, the focused pane alone determines which agent appears on the session card.

- A terminal with newer command-start or recent-output evidence shows as running even if old metadata says waiting.
- A terminal with command-finished evidence or unread output shows finished/idle according to current scrollback and unread state.
- A quiet live terminal with old waiting metadata settles back to idle instead of staying visually stuck.
- A fresh repeated waiting phase stays waiting for the full bounded window.
- A terminal session refresh failure keeps previous rows usable and labels them stale until a later successful refresh clears the label.
- Reopening a background shell keeps the selected row active even when placement persistence is temporarily unavailable, without creating or deleting a runtime session or showing a false update-failed banner.
- Explicit terminal pane close frames are accepted by the zellij WebSocket protocol instead of surfacing as invalid-message noise.
- Matrix does not silently delete saved owner metadata while deriving the safer visible state.
- Stale alias and canonical pane references for the same missing terminal appear as one recoverable session row.
- Renaming a session to its existing name returns the same alias/reference metadata as a normal session read.
- Creating an already-live session or renaming through a known alias returns canonical alias/reference metadata instead of a partially decorated row or 404.
- Renaming a canonical session to one of its aliases makes that alias the canonical name and removes the stale alias entry.
- Operators can check coarse terminal/session health through the gateway when SSH is unavailable.

## Remaining Spec Gaps

- Full end-to-end proof with a real long-running process across browser tab switch, backgrounding, refresh, WebSocket reconnect, and return still needs a browser/runtime integration or preview-VPS test. This PR now proves the gateway/zellij adapter contract does not create or delete sessions during background/reopen/reconnect read flows, but it still does not stand up a live zellij process in Playwright.
- Workspace-session and legacy alias reconciliation is now represented in the registry read model and route tests. Broader cross-store ingestion of every possible workspace alias source remains outside this slice.
- Normal-read stale pane recovery now returns recoverable rows for saved pane references in `/api/terminal/sessions`. A richer user-facing recovery action flow for every layout restore path remains outside this slice.
- Public docs are not updated because the user-visible copy change is limited to the terminal drawer stale label and the diagnostics surface is an internal gateway health extension.

## Tests To Run

```bash
bun run test tests/gateway/shell-registry.test.ts
bun run test tests/gateway/shell-zellij.test.ts
bun run test tests/gateway/agent-session-state.test.ts
bun run test tests/gateway/shell-routes.test.ts
bun run test tests/gateway/terminal-zellij-ws.test.ts
bun run test tests/shell/terminal-session-state.test.ts
bun run test tests/shell/terminal-app-component.test.tsx
bun run typecheck
bun run check:patterns
npx react-doctor@latest shell
git diff --check
```

## Manual Verification

1. Start from a runtime whose `system/shell-sessions.json` contains an active terminal with old `visualStatus: "waiting"` metadata.
2. Confirm that a live command-start mark or recent terminal output changes the visible terminal status to running after refresh.
3. Let the terminal become quiet without unread output and refresh again.
4. Confirm the visible status settles to idle, and the saved metadata file is not deleted or rewritten solely to remove the old visual status.
5. Force `/api/terminal/sessions` to fail transiently while the Shells drawer has rows.
6. Confirm the rows remain visible with a stale label, then recover the route and confirm the label clears.
7. Call `/api/terminal/health?include=sessions` and confirm the response contains only coarse aggregate counts.
