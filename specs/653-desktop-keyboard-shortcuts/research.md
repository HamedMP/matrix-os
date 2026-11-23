# Research: hidden menu accelerators (Task 2 spike)

Date: 2026-11-22. Electron 41.10.7. Platform tested: **Linux only** (X11 under Xvfb, no window
manager). macOS is still open and will be checked separately. Windows is not testable here.

## Method

A throwaway script (session scratchpad, not in the repo) built:

- An application menu with a visible item `Ctrl+Tab`, a hidden item `Alt+Space` and a hidden
  item `Ctrl+Shift+K` (both hidden items: `visible: false`, `acceleratorWorksWhenHidden: true`).
  Each `click` logs `MENU`.
- A `BrowserWindow` page plus a child `WebContentsView`. Each page has a capture-phase `keydown`
  listener that logs `PAGE`. `before-input-event` is also logged on both.
- Focus was moved with `webContents.focus()` and confirmed with `isFocused()`.

Keys were sent two ways:

1. **xdotool** (`xdotool windowfocus` + `xdotool key`, real X events through XTEST). This goes
   through the same native path as a physical keyboard, so it is the trustworthy result.
2. **`webContents.sendInputEvent`**. This injects into the renderer. It agreed with xdotool in
   every case, but taken alone it would prove less.

A second run added a page listener that calls `preventDefault()` on the keydown.

## Results (Linux)

| # | Question | Result | Method | Confidence |
|---|----------|--------|--------|------------|
| 1 | Visible item accelerator (`Ctrl+Tab`) fires | Yes | xdotool and sendInputEvent | High |
| 2 | Hidden item accelerator fires (`Alt+Space`, `Ctrl+Shift+K`) | Yes, both | xdotool and sendInputEvent | High |
| 3 | Both fire while the child `WebContentsView` has focus | Yes | xdotool and sendInputEvent | High |
| 4 | `setIgnoreMenuShortcuts(true)` stops them; `false` brings them back | Yes, for both the child view and the main page (set on the focused webContents) | xdotool and sendInputEvent | High |
| 5 | Page `keydown` also receives the key when the accelerator fires | Yes: the page gets the keydown **and** the menu click runs (double handling) | xdotool and sendInputEvent | High |
| 5b | Page calls `preventDefault()` on keydown | Menu item does **not** fire (visible or hidden), in both page and child view | xdotool and sendInputEvent | High |

What this means: on Linux the key goes to the page first. The menu accelerator only runs if the
page does not `preventDefault()` the keydown. So any page code that swallows keys (for example a
terminal emulator such as xterm.js, or editor key handlers) will block the menu shortcut for that
key. `before-input-event` saw every key before the page in all cases.

Limits: tested under Xvfb with no window manager. A real desktop WM may grab some combos before
the app sees them (GNOME/KDE commonly use `Alt+Space` for the window menu). Wayland was not
tested.

## Documentation notes (from Electron 41 `electron.d.ts`)

- `acceleratorWorksWhenHidden` (`@platform darwin`): "default is `true`, and when `false` will
  prevent the accelerator from triggering the item if the item is not visible." It is macOS-only;
  on Linux the hidden item fired anyway, so this flag has no effect there.
- `registerAccelerator` (`@platform linux,win32`): "If false, the accelerator won't be registered
  with the system, but it will still be displayed. Defaults to true."
- `setIgnoreMenuShortcuts`: "Ignore application menu shortcuts while this web contents is focused."
- The `before-input-event` docs say: "To only prevent the menu shortcuts, use
  `setIgnoreMenuShortcuts`".

## Recommendation

Decision rule from the brief: hidden items fire on Linux, so the Linux half passes. If the macOS
check also passes, Task 4 uses hidden menu items for bindings 2-4 on every platform. Windows stays
unverified and is treated like Linux.

Two follow-ups for Task 4:

1. Double handling is real on Linux. The renderer must not also act on a key that is bound as a
   menu shortcut, or the action runs twice. Keep one owner per binding.
2. A page `preventDefault()` silently disables the menu shortcut. Surfaces that swallow keys
   (Terminal) need either `setIgnoreMenuShortcuts` decisions made on purpose, or a
   `before-input-event` matcher for the bindings that must win over the page.
