# Terminal Clipboard Interaction Contract

## Applicability

This contract applies to:

1. Native Electron Canvas terminal (`TerminalView`).
2. Native Electron Desktop terminal (the same `TerminalView`).
3. Web Canvas terminal (`TerminalPane`).
4. Web Desktop terminal (the same `TerminalPane`).

It does not change clipboard behavior for non-terminal controls or sandboxed apps.

## Shortcut contract

| Focus and platform | Interaction | Required terminal result |
|---|---|---|
| Focused terminal, macOS | Command+C | Copy the exact active xterm selection once. |
| Focused terminal, macOS | Command+Shift+C | Copy the exact active xterm selection once. |
| Focused terminal, macOS | Command+V | Paste supported clipboard content into that terminal once without Enter. |
| Focused terminal, macOS | Command+A | Select all currently available xterm text. |
| Focused terminal, existing cross-platform behavior | Ctrl+Shift+C / Ctrl+Shift+V | Preserve existing terminal Copy/Paste behavior. |
| Focused terminal, no selection | Copy shortcut | Do not overwrite the clipboard or claim success. |
| Key repeat or unsupported modifiers | Any | Do not execute a terminal clipboard action. |
| Focus outside a terminal | Any terminal combination | Preserve established non-terminal handling. |

A recognized terminal action prevents competing xterm/shell/native handling for that interaction. An unrecognized or inapplicable action is not consumed.

## Copy contract

- `terminal.getSelection()` is authoritative.
- The complete text is snapshotted exactly once when Copy begins.
- Wrapped lines, blank lines, whitespace, punctuation, emoji, combining characters, and wide characters follow xterm's returned textual representation.
- Keyboard and context-menu Copy receive the same snapshot for the same selection.
- Copy never clears or modifies the live selection.
- Clipboard failure returns a typed failure and displays only generic feedback.
- Clipboard text is never logged, persisted, synchronized, or sent to telemetry.

## Paste contract

- A paste command captures the initiating terminal identity and session generation before reading the clipboard.
- Text uses the existing bounded/bracket-aware terminal input path and is emitted once without an automatic Enter.
- Existing supported image paste uses the existing bounded upload path; adding explicit Command+V must not disable it.
- If the target is disconnected, unmounted, or replaced before the read completes, zero content is written.
- An empty, denied, unavailable, or failed read writes zero content and produces a bounded outcome.
- One native `paste` event plus its initiating keyboard event must not cause two writes.

## Right-click and context-menu contract

- Both xterm instances set `rightClickSelectsWord: false`.
- Capture-phase host routing runs before xterm can process a secondary click or context menu.
- If a selection exists, right-click preserves it and snapshots its full text before opening the Matrix terminal menu.
- Copy is enabled iff that immutable snapshot is non-empty and its terminal owner is still valid.
- A safe link under the pointer may add link actions but never replace or shorten the selection.
- The snapshot remains stable until action/dismissal and is discarded immediately afterward.
- Escape, light dismiss, and actions restore focus only to the still-mounted originating terminal.

## Pointer and mouse-aware TUI contract

| State/event | Routing |
|---|---|
| No xterm selection | Forward existing down/up/move reports unchanged to xterm and the TUI. |
| Completed selection + passive no-button movement | Stop before xterm's TUI mouse reporter. |
| Completed selection + secondary-button down/up | Stop before xterm's TUI mouse reporter and preserve selection for context-menu routing. |
| Completed selection + contextmenu | Open the Matrix menu from the preserved selection. |
| Completed selection + deliberate left-button selection | Allow xterm to replace/clear the range normally. |
| Typing, paste, buffer transition, lost retained content | Allow normal xterm invalidation behavior. |

This contract intentionally pauses TUI hover/right-click reporting only while selected text exists. Reporting resumes as soon as no selection exists.

## Canvas coordinate contract

- Xterm cell-oriented pointer events retain the existing Canvas transform correction.
- Context-menu placement uses raw viewport coordinates.
- Link hit testing must use one documented coordinate conversion and must not double-unscale.
- Native `visualScale` is forwarded to every terminal tab/view; behavior is verified at 0.5, 1, and 2.
- Web behavior is verified at interactive zoom 0.25, 0.5, 1, 1.5, and 3.
- Moving web Canvas through the below-0.25 non-interactive preview must not recreate xterm or silently replace its selection when returning to an interactive zoom.

## Focus and pane isolation contract

- The focused terminal is the only action owner.
- Selection from another pane/window is never used as fallback.
- Async paste checks the captured owner/session generation immediately before writing.
- Menu close cannot focus a terminal that has unmounted or ceased to be the originating action owner.

## Failure and privacy contract

Allowed UI feedback is fixed, generic product copy such as “Copy failed. Try again.” or “Paste failed. Try again.” It must not include:

- selected or clipboard content;
- raw exception text;
- provider or browser internals;
- filesystem paths or filenames;
- terminal session identifiers.

Diagnostics may record only the operation category and a bounded error class. Clipboard contents remain local to the user-requested operation.

## Integration boundary

No new HTTP endpoint, WebSocket frame, IPC command, database model, or file operation is introduced. The existing authenticated terminal transport and existing image paste/upload interfaces remain authoritative. Consequently, this contract adds no new auth matrix; it requires regression verification of the current boundary rather than a new one.
