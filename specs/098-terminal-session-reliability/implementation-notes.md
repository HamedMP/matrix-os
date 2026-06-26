# Spec 098 Implementation Notes: Terminal Session Reliability

## Completed In This PR

### Sticky Visual Status

Older bundles could persist terminal `visualStatus` metadata such as `waiting` or `running` in `system/shell-sessions.json`. When a newer bundle loaded that owner metadata, the saved visual state could keep a live terminal looking stuck even after current scrollback showed newer command activity, command completion, or a quiet live shell.

The gateway now constrains how session summaries interpret that metadata. Current runtime/session existence and scrollback activity evidence drive the visible status. Durable metadata is preserved as owner data, but stale transitional states are not treated as authoritative forever. A repeated explicit `waiting` intent also refreshes its own timestamp, so a fresh waiting phase does not expire against an older waiting timestamp.

### Session Truth And Reconciliation

Gateway registry summaries now prefer live runtime existence and scrollback activity over durable UI metadata for liveness and visual status. Missing runtime sessions are reconciled to exited metadata during normal registry reads, while live runtime sessions missing metadata are adopted. Existing shell tests cover canonical session restoration, legacy PTY layout replacement, saved canonical session recreation before layout restore, active row focus without duplicate tabs, and delete-scoped pane removal.

### Stale Refresh UX And Optimistic Rollback

The shell sidebar keeps last-known terminal rows visible when refresh fails, labels them as stale, and keeps the existing refresh action available. Session UI-state patch/rollback behavior is extracted into `terminal-session-state.ts` so placement, seen-state, and visual-status optimistic updates can be tested without rendering the whole sidebar. Failed optimistic rollbacks only revert fields that still match the failed optimistic patch, preserving concurrently refreshed fields.

### Terminal Health Diagnostics

`/api/terminal/health?include=sessions` now returns coarse terminal/session counts for operator diagnosis without direct SSH access. The response includes only aggregate counts and generic failure codes; it does not expose session names, filesystem paths, provider details, or raw runtime errors.

## Expected User Experience

- A terminal with newer command-start or recent-output evidence shows as running even if old metadata says waiting.
- A terminal with command-finished evidence or unread output shows finished/idle according to current scrollback and unread state.
- A quiet live terminal with old waiting metadata settles back to idle instead of staying visually stuck.
- A fresh repeated waiting phase stays waiting for the full bounded window.
- A terminal session refresh failure keeps previous rows usable and labels them stale until a later successful refresh clears the label.
- Matrix does not silently delete saved owner metadata while deriving the safer visible state.
- Operators can check coarse terminal/session health through the gateway when SSH is unavailable.

## Remaining Spec Gaps

- Full end-to-end proof with a real long-running process across browser tab switch, backgrounding, refresh, WebSocket reconnect, and return still needs a browser/runtime integration or preview-VPS test. This PR strengthens and tests the component and gateway contracts, but it does not stand up a live zellij process in Playwright.
- Workspace-session alias reconciliation remains covered at the shell/session boundary through existing attach and layout tests, but this PR does not introduce a new cross-store canonical alias service.
- Public docs are not updated because the user-visible copy change is limited to the terminal drawer stale label and the diagnostics surface is an internal gateway health extension.

## Tests To Run

```bash
bun run test tests/gateway/shell-registry.test.ts
bun run test tests/gateway/shell-routes.test.ts
bun run test tests/shell/terminal-session-state.test.ts
bun run test tests/shell/terminal-app-component.test.tsx
bun run typecheck
bun run check:patterns
npx react-doctor@latest shell
```

## Manual Verification

1. Start from a runtime whose `system/shell-sessions.json` contains an active terminal with old `visualStatus: "waiting"` metadata.
2. Confirm that a live command-start mark or recent terminal output changes the visible terminal status to running after refresh.
3. Let the terminal become quiet without unread output and refresh again.
4. Confirm the visible status settles to idle, and the saved metadata file is not deleted or rewritten solely to remove the old visual status.
5. Force `/api/terminal/sessions` to fail transiently while the Shells drawer has rows.
6. Confirm the rows remain visible with a stale label, then recover the route and confirm the label clears.
7. Call `/api/terminal/health?include=sessions` and confirm the response contains only coarse aggregate counts.
