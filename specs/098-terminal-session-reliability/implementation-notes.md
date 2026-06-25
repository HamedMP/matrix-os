# Slice 1 Implementation Notes: Sticky Terminal Visual Status

## Bug Fixed

Older bundles could persist terminal `visualStatus` metadata such as `waiting` or `running` in `system/shell-sessions.json`. When a newer bundle loaded that owner metadata, the saved visual state could keep a live terminal looking stuck even after current scrollback showed newer command activity, command completion, or a quiet live shell.

Slice 1 constrains how gateway session summaries interpret that metadata. Current runtime/session existence and scrollback activity evidence drive the visible status. Durable metadata is preserved as owner data, but stale transitional states are not treated as authoritative forever.

## Expected User Experience

- A terminal with newer command-start or recent-output evidence shows as running even if old metadata says waiting.
- A terminal with command-finished evidence or unread output shows finished/idle according to current scrollback and unread state.
- A quiet live terminal with old waiting metadata settles back to idle instead of staying visually stuck.
- Matrix does not silently delete saved owner metadata while deriving the safer visible state.

## Tests To Run

```bash
bun run test tests/gateway/shell-registry.test.ts
bun run check:patterns
```

## Manual Verification

1. Start from a runtime whose `system/shell-sessions.json` contains an active terminal with old `visualStatus: "waiting"` metadata.
2. Confirm that a live command-start mark or recent terminal output changes the visible terminal status to running after refresh.
3. Let the terminal become quiet without unread output and refresh again.
4. Confirm the visible status settles to idle, and the saved metadata file is not deleted or rewritten solely to remove the old visual status.
