# Feature Specification: Customizable Keyboard Shortcuts (Electron Desktop)

**Feature Branch**: `hamed-eng-533-customizable-keyboard-shortcuts`
**Created**: 2026-11-22
**Status**: Approved by owner 2026-11-22
**Tracking**: [ENG-533](https://linear.app/matrix-os/issue/ENG-533/customizable-keyboard-shortcuts-in-electron-desktop)
**Input**: "We have a custom Cmd+Q to close the app inside Matrix. Add shortcuts for switching apps and opening the App Launcher, add the bindings to Settings so people can customize them, find 5–10 more shortcuts (some bound by default, some unbound), and make the Settings UI as good as Granola's and Raycast's."

## Goal

Electron Desktop users can drive Matrix from the keyboard and change any
shortcut from Settings. Today about ten shortcuts are hardcoded in two places
and none can be changed.

## Owner Decisions (2026-11-22)

1. **Electron Desktop only for now.** Web Desktop and Web Canvas follow in a
   separate change.
2. **Simple cycle first.** Ctrl+Tab moves to the next app and Ctrl+Shift+Tab to
   the previous one. No hold-to-switch overlay and no most-recently-used order.
3. **App Launcher on Option+Space.**
4. **Bindings are editable in Settings**, with a UI modelled on Granola's
   shortcut settings: one row per action, key chips, remove, Reset, Add shortcut.
5. **Add 5–10 more actions**, some with a default binding and some with none.
6. **Cmd+1–9 switches apps.** The Task workspace panel toggles that use those
   keys today move to other keys.
7. **Verify the UI on the owner's Mac** (`/mac-verify`) once it exists.

Everything below that is not in this list is the author's proposal.

## Non-goals

- Taking over Cmd+Tab, Cmd+Space, Alt+Tab or other operating-system shortcuts.
  macOS and Windows consume them before the app sees them.
- Sequences ("press A, then B") and hold-to-activate bindings.
- Global shortcuts that work while Matrix is not focused.
- Syncing bindings across devices or to the Matrix account.
- Shortcuts inside individual apps (terminal, editor, composer). Those stay as
  they are.
- Web Desktop, Web Canvas, Web Mobile and Native Mobile.

## Anti-goals

- A rebound action that still fires on its old key.
- A shortcut that works in the shell chrome but not while an embedded app or the
  terminal has focus.
- A Settings change that can leave the user with a broken or unrecoverable
  binding set.

## Actions and Defaults

"Mod" is Cmd on macOS and Ctrl on Windows and Linux.

| Group | Action | Default (macOS) | Default (Windows/Linux) | Status |
| --- | --- | --- | --- | --- |
| Apps | Next app | Ctrl+Tab | Ctrl+Tab | exists, renderer-only |
| Apps | Previous app | Ctrl+Shift+Tab | Ctrl+Shift+Tab | exists, renderer-only |
| Apps | Open App Launcher | Option+Space | Ctrl+Space | new |
| Apps | Close app | Cmd+Q | Ctrl+Q | exists |
| Apps | Minimize app | Cmd+M | Ctrl+M | new |
| Apps | Reopen closed app | Cmd+Shift+T | Ctrl+Shift+T | new |
| Apps | Switch to app 1 … 9 | Cmd+1 … Cmd+9 | Ctrl+1 … Ctrl+9 | new |
| Apps | Show desktop | none | none | new |
| Apps | Toggle app full size | none | none | new |
| Apps | Open Files | none | none | new |
| Navigation | Command palette | Cmd+K | Ctrl+K | exists |
| Navigation | Go to file | Cmd+P | Ctrl+P | exists |
| Navigation | Settings | Cmd+, | Ctrl+, | exists |
| Tabs | New | Cmd+N | Ctrl+N | exists |
| Tabs | New tab | Cmd+T | Ctrl+T | exists |
| Tabs | Close tab | Cmd+W | Ctrl+W | exists |
| Chat | New agent thread | Cmd+J | Ctrl+J | exists |
| Chat | Open Chat | Cmd+Shift+O | Ctrl+Shift+O | exists, renderer-only |
| Terminal | Terminal | Cmd+Option+T | Ctrl+Alt+T | exists |
| Terminal | Terminal window | Cmd+Option+Shift+T | Ctrl+Alt+Shift+T | exists (macOS, Linux) |

Notes on behavior:

- **Next / previous app** cycles the open apps in taskbar order, skipping closed
  and minimized ones, and wraps around. With one or no open app it does nothing.
- **Open App Launcher** toggles the existing launcher (`appLauncherOpen` in
  `desktop/src/renderer/src/stores/ui.ts`). Windows and Linux default to
  Ctrl+Space because Alt+Space opens the window system menu there.
- **Minimize app** takes Cmd+M the same way Close app took Cmd+Q: it acts on the
  selected Matrix app. The native "Minimize" item stays in the Window menu
  without a shortcut.
- **Switch to app N** selects the Nth icon in the taskbar, counting the fixed
  Files slot and minimized apps, so the number matches what the user sees. A
  minimized app is restored. No Nth icon, no effect. These are nine separate
  actions, shown as one collapsible group.
- **Task workspace panel toggles move.** Cmd+1–7 toggles panels in the Task
  workspace today (`TaskWorkspace.tsx:145`). They move to Cmd+Option+1–7
  (Ctrl+Alt+1–7 on Windows and Linux) so Cmd+1–9 is free for apps. They stay a
  fixed in-view shortcut, not a Settings row. The handler must match on
  `event.code`, because Option+digit produces a symbol on macOS. Update the
  hint in `PanelStrip.tsx`, and reserve these combinations in the validator.
- **Reopen closed app** reopens the most recently closed app in this session,
  from the tab description saved when it closed: the same file, folder, project
  or chat. A terminal reopens as a new session. Window position is not
  restored. Closes from the taskbar, Close tab and Close app all count; closing
  one of several sibling tabs inside an app does not. Keep the last 10 closed
  apps in memory only.
- **Open Chat** is today's Cmd+Shift+O: it opens or focuses the chat with
  Matrix. It is listed once.
- **Show desktop** minimizes all open apps; pressing it again restores the ones
  it minimized.
- **Zoom, reload, full screen, copy/paste and the other standard menu roles are
  not customizable.** Their keys are reserved (see Validation).

## Settings UI

A new **Shortcuts** section in Electron Desktop Settings, in the "You" group
after Appearance.

```
Shortcuts
Change how you control Matrix from the keyboard. Saved on this computer.

[ Search shortcuts…                                   ]

APPS
┌────────────────────────────────────────────────────────────────┐
│ Next app                                        [ ⌃ ⇥ ]  ×     │
│ Move to the next open app.                Reset   Add shortcut │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ Open App Launcher                           [ ⌥ Space ]  ×     │
│ Show or hide the App Launcher.                    Add shortcut │
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│ Show desktop                                                   │
│ Minimize every open app.                          Add shortcut │
└────────────────────────────────────────────────────────────────┘
NAVIGATION
…
                                              Restore all defaults
```

- **Row**: action name, one-line description, its bindings as key chips on the
  right. Each chip has a remove (×) control. An action can hold up to 4
  bindings, stacked as in the Granola reference.
- **Key chips**: macOS shows symbols (⌃ ⌥ ⇧ ⌘); Windows and Linux show words
  (Ctrl, Alt, Shift).
- **Add shortcut** starts recording: a chip reading "Press keys…" appears with
  an accent ring and shows modifiers live as they are held. The first valid
  combination is saved. Escape or clicking away cancels.
- **Reset** appears only on rows that differ from the default and restores that
  row. The space for it is reserved so rows do not shift.
- **Conflict**: if the combination belongs to another action, nothing is saved
  yet. The row shows "⌃⇥ is used by Next app" with **Replace** and **Cancel**.
  Replace moves the binding.
- **Rejected combinations** show one line under the row and save nothing:
  "⌘Space is reserved by macOS", "⌘C is reserved for Copy", or "Add a modifier
  key such as ⌘ or ⌃".
- **Search** filters rows by action name, description and binding text. No match
  shows an empty state with a "Clear search" button.
- **Restore all defaults** asks for confirmation in a dialog, then clears every
  override.
- **Save failure**: the row keeps its previous bindings and shows "Could not
  save shortcut. Please try again."
- Menu items in the app menu show the action's first binding and update as soon
  as a binding changes.

Use the shared `packages/ui` controls (Button, Input, Dialog) and existing
theme tokens. No native controls styled to look like library components.

## Approaches

How a key press reaches an action:

1. **App-menu accelerators (chosen).** Every binding becomes an accelerator on
   an app-menu item, and the menu is rebuilt when bindings change. This is how
   Cmd+Q works today. It fires wherever focus is, including inside an embedded
   app (`WebContentsView`) and the terminal, and the menu shows the current key
   for free. Cost: second and later bindings, and actions with no natural menu
   home, need hidden menu items, and hidden-item accelerators are documented
   only for macOS.
2. **`before-input-event` in the main process.** One matcher for every web
   contents, same behavior on every platform. Cost: it must be attached to every
   window and embed as they are created, and macOS cannot display a menu key
   without also registering it, so each press could fire twice.
3. **Renderer `keydown` listener.** Simplest, and what Ctrl+Tab uses today.
   Rejected: it does not fire while an embedded app has focus.

Approach 1 is chosen because it is proven in this codebase and gives native
menu labels. **Spike first**: confirm hidden-item accelerators fire on Windows
and Linux. If they do not, use approach 2 for those bindings on those platforms
only.

## Architecture

**Shared registry** — `packages/ui/src/shortcuts/` (pure TypeScript, so Web
Desktop and Web Canvas can adopt it later):

- The action list: id, label, description, group, per-platform default
  bindings.
- A binding is a normalized string in Electron accelerator form, for example
  `Ctrl+Tab` or `Cmd+Shift+T`: modifiers in a fixed order, then one key.
- Pure helpers: build a binding from a `KeyboardEvent`, validate it, find conflicts,
  resolve defaults plus overrides into the effective bindings, format a binding
  for display.
- Zod schemas for the stored shape and the IPC payloads.
- **Key identity**: a binding names the character on the key, because that is
  what menu accelerators match. The recorder uses `event.key` when it is a
  printable ASCII character or a named key (Tab, Space, F5, arrows). When it is
  not, as with Option+letter on macOS or a non-Latin layout such as Persian, it
  falls back to the US key at that position from `event.code`. The spike must
  confirm on macOS that a binding recorded under a non-Latin layout fires from
  the same physical key.

**Stored shape** — a new `keyboardShortcuts` key in the existing Electron state
store (the one `appearance` uses):

```ts
{ version: 1, overrides: { [actionId]: string[] } }
```

Only actions the user changed are stored. An empty array means "explicitly
unbound". Actions without an override follow the shipped defaults, so future
default changes reach users who never customized that action.

**Main process is the source of truth.**

- On startup it loads the stored value, resolves effective bindings, and builds
  the app menu from them (`menu-template.ts` takes bindings as input instead of
  hardcoded accelerators).
- `shortcuts:get` returns the effective bindings and which actions are
  overridden.
- `shortcuts:set` takes the full overrides object, validates it, persists it,
  rebuilds the menu, and sends `shortcuts:changed` to every window.
- `shortcuts:set-recording` turns menu shortcuts off for the Settings window
  while a binding is being recorded (`webContents.setIgnoreMenuShortcuts`), so
  pressing an existing binding records it instead of running it.
- A menu item click sends one event, `shortcut:action { id }`, to the main
  window through the existing menu router, so Terminal-window routing keeps
  working.

**Renderer.**

- One table maps action id to handler in `mission-control/shortcuts.ts`. The
  hardcoded `keydown` branches for registry actions are removed, so the menu is
  the only path and an old key cannot keep firing. The existing `menu:action`
  values that become registry actions move to `shortcut:action`.
- A small store holds the effective bindings (loaded with `shortcuts:get`,
  updated on `shortcuts:changed`). Labels that show a shortcut, such as
  tooltips using `desktopShortcutLabel`, read from it.
- The Settings section is a thin adapter around the shared
  `ShortcutSettings` component in `packages/ui/src/shortcuts/`.

## Validation and Security

All checks run in the shared validator and again in the main process on
`shortcuts:set`. The renderer is not trusted.

- Action ids must be in the registry enum. Unknown ids are rejected.
- At most 4 bindings per action; each binding at most 40 characters and must
  parse as modifiers plus one known key.
- A binding needs at least one of Cmd, Ctrl or Alt, unless the key is F1–F24.
  Shift alone is not enough.
- Reserved and rejected: operating-system shortcuts the app cannot receive
  (Cmd+Tab, Cmd+Space, Cmd+` on macOS; Alt+Tab, Alt+F4, Alt+Space on Windows and
  Linux) and the fixed menu roles (undo, redo, cut, copy, paste, select all,
  hide, zoom, reload, full screen, dev tools).
- The same binding may not appear on two actions. The UI resolves this with
  Replace; the main process rejects a payload that still contains a duplicate.
- Errors returned to the renderer are generic. No Zod issues or file paths.
- The stored value stays inside the state store's existing 64 KB bound.

Auth: these IPC channels are available to the app's own windows only, the same
as `state:get` and `state:set`. Embedded apps have no access to them.

## Failure Modes

| Case | Behavior |
| --- | --- |
| Stored value is missing, corrupt, or a future version | Use defaults, log a warning, do not overwrite the file until the user saves. |
| Stored override names an action that no longer exists | Drop it when resolving. |
| A new default collides with a user's override | The override keeps the key; the new default is not applied to that action. |
| Persist fails | Menu and renderer keep the last saved bindings; the UI shows the save error. Nothing is applied optimistically. |
| Settings closes, reloads, or loses focus while recording | Main re-enables menu shortcuts. It also re-enables them 30 seconds after recording starts if no stop arrived. |
| Two windows change bindings at once | Main applies `shortcuts:set` calls one at a time; the last one wins and every window receives the result. |
| User unbinds everything | Allowed. Every action stays reachable from the menu or the UI, and "Restore all defaults" is always available. |

Resources: the closed-app history is capped at 10 entries. No timers other than
the 30-second recording guard, which is cleared on stop and on window close.

## Acceptance Checks

1. Ctrl+Tab and Ctrl+Shift+Tab cycle open apps, including while focus is inside
   an embedded app and inside the terminal.
2. Option+Space toggles the App Launcher on macOS.
3. Rebinding "Close app" to another key makes the new key work and Cmd+Q stop
   closing the app, without restarting. The menu shows the new key.
4. The rebinding survives quitting and reopening the app.
5. Recording a key that another action uses offers Replace; accepting moves it.
6. Recording Cmd+C is refused with the reserved message. Cmd+Space usually
   never reaches the app, so its rejection is checked in validator tests only.
7. Reset restores one row; "Restore all defaults" restores all.
8. An unbound action (Show desktop) can be given a binding and then works.
9. A corrupt stored value starts the app with defaults.

## Testing

Tests first, per the constitution.

- Registry: binding from key event, validation, reserved list, conflicts,
  resolve with overrides, display formatting per platform.
- Menu template: accelerators come from bindings; hidden items for extra
  bindings; rebuilt output after a change.
- Main IPC: `shortcuts:set` accepts valid input, rejects unknown ids,
  duplicates, reserved keys and oversized input; persists; broadcasts.
- Renderer: each action id runs its handler; cycle, switch-to-N, reopen and
  show-desktop behavior on the stores.
- Settings component: record, add, remove, reset, conflict replace, rejection
  message, search, save failure.

## Surfaces and Evidence

| Surface | In scope | Notes |
| --- | --- | --- |
| Electron Desktop | yes | Screenshots and a recording from a real build, macOS at minimum. |
| Web Desktop, Web Canvas | no | Deferred by owner decision 1. Browsers reserve Ctrl+Tab, Cmd+1–9 and Cmd+Shift+T, so they need different defaults. The shared registry is built so they can adopt it. This `N/A` needs reviewer approval. |
| Web Mobile, Native Mobile | no | No hardware-keyboard shortcut surface. |

## Risks and Open Items

- **Hidden menu accelerators on Windows and Linux**: covered by the spike above.
- **Option+Space** is also used as a global hotkey by Raycast and some AI
  desktop apps. Where one is installed, theirs wins; the user can rebind.
- **Cmd+M and Cmd+1–9** may already mean something inside the terminal or
  editor. The plan must check each default against the in-app handlers and drop
  or change a default that would take a key from them.
- **Stakeholder review**: suggest design review of the Settings section before
  it is marked ready.

## Left to the Builder

- File layout inside `packages/ui/src/shortcuts/` and the split into one or two
  pull requests (registry, main process and actions first; Settings UI second)
  if the diff approaches the size limit.
- Exact copy for descriptions, and icons.
- How the nine "Switch to app N" actions are grouped in the Settings list.
