# Web Desktop and Electron Desktop parity audit

Date: 2026-08-27  
Ground truth: Electron Desktop

## Outcome

This audit records the implementation baseline before the OS-view parity stack.
Web Desktop is the default browser renderer and Electron Desktop is the ongoing
visual and interaction reference for shared desktop surfaces. The deprecated
menu bar and Developer-first presentation are removed from the primary path.
Web Canvas remains implemented but is not yet exposed; restoring its launcher
entry and state-preserving switch is governed by `specs/119-os-view-parity/spec.md`.

Terminal remains an app surface inside the OS window. Its `appThemeId` controls
Terminal chrome while the persisted terminal `themeId` controls shell content;
the Matrix OS theme continues to control the surrounding Desktop surface.

## Parity matrix

| Area | Before | Current result |
| --- | --- | --- |
| Primary renderer | Developer, with Canvas exposed beside it | Web Desktop default; Web Canvas restoration is the next governed implementation slice |
| Top chrome | macOS-like menu bar and app menus | Removed from the canonical browser Desktop |
| Desktop plane | Terminal-first blank workspace | Native-style desktop destinations over the configured wallpaper |
| Window chrome | OS-theme-specific traffic lights/caption buttons | Native compact close/minimize/maximize controls with shared 38px gesture bar |
| Dock/taskbar | Configurable left/right/bottom legacy dock | Centered native-style glass taskbar |
| Running apps | Mixed with pinned/config controls | Files plus running app surfaces, including minimized restore targets |
| App launcher | Dock-management Mission Control panel | Searchable full-screen launchpad with light dismiss and Escape behavior |
| Terminal | Existing Terminal app inside legacy chrome | New Terminal app remains intact inside native-style OS chrome |
| Themes | Shell theme plus Terminal app/content themes | Preserved as independent concerns |

## Evidence

- [Before: Developer shell](./before-web-developer-shell.png)
- [After: Desktop shell](./after-web-desktop-shell.png)
- [After: Desktop launchpad](./after-web-desktop-launchpad.png)

## Follow-up parity work

- Browser, Plugins, and Projects desktop destinations need Web Desktop routes
  before they can match the complete native fixed destination set.
- Settings still opens through the Web modal host rather than a normal Web
  Desktop window surface.
- The Electron Desktop show-desktop background animation is not yet wired to the
  Web Desktop plane.
- Web Canvas launcher access, independent presentation preference, and
  state-preserving switching are deferred to the OS-view parity stack.

## Verification

- Desktop mode migration and renderer visibility unit tests.
- Desktop structure, launcher/taskbar behavior, and minimized restore tests.
- Browser interaction checks for launcher open/dismiss, Files launch, Terminal
  minimize, and Terminal restore.
- Web renderer TypeScript check.
- Production Web OS-view build (`build:shell:production` retains its compatibility name).
