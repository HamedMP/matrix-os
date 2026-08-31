# Phase 1 Data Model: Terminal Clipboard and Selection

This feature introduces no persisted data. The model below defines transient renderer state and pure decisions so both terminal implementations enforce the same invariants.

## TerminalSelection

The live logical selection owned by one xterm instance.

| Field | Type | Rules |
|---|---|---|
| `ownerId` | pane/window instance identity | Stable only for the mounted terminal instance; never persisted. |
| `sessionGeneration` | opaque monotonic generation | Changes when the renderer attaches to a different session or becomes invalid. |
| `text` | string | Read from `terminal.getSelection()` only; may contain multiline, wrapped, whitespace, or Unicode content. |
| `range` | xterm selection position | Optional for assertions/visual stability; never reconstructed after xterm invalidates it. |
| `active` | boolean | Equivalent to xterm reporting a non-empty selection. |

Invariants:

- One selection belongs to exactly one mounted xterm instance.
- DOM selection is never substituted for terminal selection.
- Copy does not mutate or clear this entity.
- Passive mouse motion and secondary-button reporting do not mutate it while active.
- Normal typing, paste, a new left-button selection, buffer switch, resize, or scrollback trim may invalidate it.

## TerminalMenuSnapshot

An immutable copy of the context required while the terminal menu is open.

| Field | Type | Rules |
|---|---|---|
| `ownerId` | pane/window instance identity | Must match the terminal that opened the menu. |
| `sessionGeneration` | opaque generation | Prevents action against a replacement session. |
| `x`, `y` | viewport coordinates | Used only for menu placement; not Canvas-unscaled twice. |
| `selectionText` | string | Snapshotted before xterm right-click handling; cleared on close/unmount. |
| `link` | terminal link or null | Optional link resolved at the pointer; does not replace the selection. |

Validation:

- Copy is enabled iff `selectionText.length > 0` and the owner is still valid.
- Link actions are present only for an existing validated terminal link.
- Dismissal cannot mutate xterm selection.

## TerminalClipboardCommand

A pure classification of a user interaction.

| Field | Type | Rules |
|---|---|---|
| `action` | `copy \| paste \| select-all` | Produced only for an exact supported shortcut/menu command. |
| `source` | `keyboard \| context-menu` | Used for behavior tests, not telemetry. |
| `ownerId` | pane/window instance identity | Captured from the focused terminal. |
| `sessionGeneration` | opaque generation | Checked again before asynchronous paste writes. |
| `selectionText` | string or absent | Immutable for copy; absent for paste/select-all. |

Validation:

- Held-key repeats do not produce a command.
- Unrecognized modifier combinations return no terminal command and retain normal shell behavior.
- Copy requires a non-empty terminal selection.
- A command is consumed by at most one renderer.

## SelectionProtectionDecision

A pure derived pointer-routing decision; it is not React state.

| Input | Result |
|---|---|
| No active selection | Forward normal xterm/TUI mouse behavior. |
| Active selection + no-button passive movement | Shield from xterm TUI reporting. |
| Active selection + secondary-button down/up/context menu | Preserve selection and route context menu before xterm. |
| Active selection + deliberate left-button action | Allow normal xterm selection behavior. |
| Keyboard input, paste, buffer switch | Allow normal xterm invalidation behavior. |

The decision must run in the event path and must not allocate or update React state for each mouse movement.

## ClipboardOperation

One bounded copy or paste attempt.

| Field | Type | Rules |
|---|---|---|
| `operationId` | local opaque token | Lives only until the promise settles or is invalidated. |
| `action` | `copy \| paste` | One operation performs one action. |
| `ownerId` | pane/window instance identity | Paste output may only return to this owner. |
| `sessionGeneration` | opaque generation | Must still match at write time. |
| `state` | `pending \| succeeded \| failed \| cancelled` | Terminal state is final. |
| `result` | bounded result code | `success`, `empty`, `unavailable`, `stale-target`, or `failed`; never raw error/content. |

State transitions:

```text
requested -> pending -> succeeded
                    -> failed
                    -> cancelled (owner/session invalidated)
```

Invariants:

- Copy snapshots the selected value before entering `pending`.
- A paste operation writes at most once.
- `failed` and `cancelled` paste operations write zero bytes.
- Copy failure preserves the live selection.
- Completion feedback is displayed within one second when the platform operation settles; no content is included.
- Operation references are released after settlement; there is no history or retry queue.

## Ownership and cleanup

The mounted `TerminalView` or `TerminalPane` is the aggregate owner for all transient entities above. Unmount/session replacement performs the cleanup boundary: remove event listeners, close and clear menu snapshots, invalidate pending generations, clear safe feedback, dispose xterm resources, and never refocus a detached element.
