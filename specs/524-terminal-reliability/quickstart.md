# Validation and Human Review

1. Build Electron from the exact PR head through Flox. Use an isolated profile and dedicated CDP port; do not modify a dirty primary checkout or stop another task's app.
2. Deploy the exact registered host bundle to an account-owned disposable Preview. Verify installed and running SHA/version, health and terminal owner access.
3. Run the original 32/33/259 reply probes on synthetic tabs. After every burst send a unique harmless command and verify output once. Exercise real new-terminal startup; do not substitute only a synthetic WebSocket test.
4. Execute the matrix below, recording pass/fail/not-run and evidence. Redact owner identifiers and all private terminal content.
5. Open the matching Electron, select the verified Preview and bring its Terminal window forward for Human Review. Ask the reviewer to create terminals, type/paste, switch tabs, scroll and resize. Keep the environment available; no merge follows automatically.

| Scenario | Web Desktop | Web Canvas | Electron Desktop | Web Mobile | Native Mobile | CLI/agent |
|---|---|---|---|---|---|---|
| Fresh startup and input burst | Pending | Pending | Pending live fix | Pending | Pending | Applicable input paths |
| Existing/old tab after update | Pending | Pending | Pending | Pending | Pending | Pending |
| Switch, hide, reconnect | Pending | Pending | Pending | Pending | Pending | Attach continuity |
| Two viewers and takeover | Pending | Pending | Pending | Pending | Pending | Separate controller contract |
| Snapshot/replay and idle output | Pending | Pending | Pending | Pending | Pending | Pending |
| Resize, last row, scroll, DPI | Pending | Pending | Pending | Pending | Pending | Dimensions |
| Paste, binary, shortcuts, TUI | Pending | Pending | Pending | Pending | Pending | Pending |
| Window close vs explicit terminate | Pending | Pending | Pending | Pending | Pending | Pending |
| Gateway/runtime restart; two upgrades | Pending | Pending | Pending | Pending | Pending | Pending |
| Project isolation and deleted references | Pending | Pending | Pending | Pending | Pending | Pending |

A platform's unsupported action is recorded with its existing limitation, not silently counted as passing. Unit/integration proof, actual runtime evidence and Human Review are separate columns in the execution record. The pending matrix is intentional: this planning artifact does not claim the complete audit has run.

## Scroll follow-up acceptance

On the exact repair head, compare a short normal-shell prompt with a long numbered history in a small window. Short content must have no empty horizontal/vertical pan. Long content must have one vertical rail anchored to the viewport edge, reaching oldest history and the final prompt. Repeat with pixel-wheel input, scrollbar dragging, window resize, tab switching, and Canvas zoom. Confirm real wide output remains reachable, native TUI mouse-wheel input still arrives, and selection/copy works. Do not equate synthetic pixel-wheel events with physical trackpad Human Review.
