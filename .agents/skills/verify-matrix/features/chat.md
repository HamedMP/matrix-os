# Chat

Chat is the Matrix assistant panel docked on the Desktop. A user picks a starter task or types a message and Matrix works in their apps.

## Sub-features

- `chat-panel` shows the greeting, starter tasks, and composer.
- `chat-starters` lists starter tasks (`Research anything`, `Plan my week`, `Build a website`, `Work on my code`).
- `chat-send` sends a typed message.
- `chat-minimize` collapses the panel to the `Open Matrix` pill and restores it.

## How to get to it (user POV)

- The `region "Matrix"` panel is open on first load of the Desktop.
- Collapsed: `button` whose name starts with `Open Matrix.`.
- Double-click `Chat` on the Desktop for the full Chat app; `button "Open as full chat"` in the panel does the same.

## Driving it with matrix-verify

Preconditions:

- Baseline from `README.md`. Sending needs a working AI route, which the local stack does not have.

- **Panel.** On load, `region "Matrix"` contains `list "Tasks"`, `textbox "Message Matrix"`, and a disabled `button "Send"`.
- **Composer enables.** Fill `textbox "Message Matrix"`. `button "Send"` becomes enabled.
- **Minimize.** Click `button "Minimize"` inside `region "Matrix"`. The `Open Matrix.` pill appears; click it to restore.
- **Send.** Blocked locally: the panel footer says "Matrix AI isn't available here". Verify sending on a preview VPS (`preview-env` skill) instead.

## Gotchas

- `region "Matrix"` has its own `Minimize` button; scope the locator to the region so you do not hit a window's `Minimize`.
- Do not report "Matrix AI isn't available here" as a failure locally; it is the expected unconfigured state.
