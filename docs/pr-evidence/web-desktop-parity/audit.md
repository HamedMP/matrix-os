# Web/Desktop shell parity audit

Date: 2026-08-27  
Ground truth: Electron native Desktop shell

## Outcome

The browser OS view now uses Desktop as its canonical renderer. The deprecated
menu bar and Developer-first presentation are removed from the primary path.
The browser keeps its existing app implementations and window state while
adopting the native Desktop composition: desktop destinations, compact OS
window controls, a centered glass taskbar, running/minimized app affordances,
and a searchable full-screen launchpad.

Terminal remains an app surface inside the OS window. Its `appThemeId` controls
Terminal chrome while the persisted terminal `themeId` controls shell content;
the Matrix OS theme continues to control the surrounding Desktop surface.

## Parity matrix

| Area | Before | Current result |
| --- | --- | --- |
| Primary renderer | Developer, with Canvas exposed beside it | Desktop only; legacy renderer values migrate to Desktop |
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

- Browser, Plugins, and Projects desktop destinations need browser-shell routes
  before they can match the complete native fixed destination set.
- Settings still opens through the browser modal host rather than a normal
  Desktop window surface.
- The native show-desktop background animation is not yet wired to the browser
  workspace plane.
- Canvas remains implemented internally but is intentionally not exposed while
  Desktop is the canonical browser renderer.

## Verification

- Desktop mode migration and renderer visibility unit tests.
- Desktop structure, launcher/taskbar behavior, and minimized restore tests.
- Browser interaction checks for launcher open/dismiss, Files launch, Terminal
  minimize, and Terminal restore.
- Shell TypeScript check.
- Production shell build.
