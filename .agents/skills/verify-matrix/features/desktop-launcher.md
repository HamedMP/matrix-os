# Desktop and App Launcher

Web Desktop shows app icons, a taskbar of running apps, a top bar of controls, and the App Launcher that lists every installed app. It is the default OS view and the entry point to every other feature.

## Sub-features

- `desktop-icons` opens an app by double-clicking its Desktop icon.
- `launcher-open` toggles the App Launcher from the taskbar.
- `launcher-search` filters installed apps by name.
- `launcher-canvas` switches to Web Canvas from the launcher.
- `window-chrome` closes, minimizes, and fullscreens app windows.

## How to get to it (user POV)

- The Desktop is the landing page at `/`.
- Taskbar `button "Open App Launcher"` (becomes `"Close App Launcher"`, pressed, while open).
- Top bar `navigation "Desktop controls"`: `Search`, `Inbox`, `Help`, `Support`.

## Driving it with matrix-verify

Preconditions:

- Baseline from `README.md`.

- **Desktop icons.** `navigation "Desktop apps"` lists `Chat`, `Terminal`, `Files`, `Editor`, `VS Code`, `Settings`, `Connect Apps`, `Browser`, `Cloud desktop`, `Notes`, `Whiteboard`. Double-click one; a window with that title and `Close`/`Minimize`/`Fullscreen` buttons appears and the taskbar gains `Focus <App>`.
- **Open launcher.** Click `button "Open App Launcher"`. A `textbox "Search apps"`, `button "Create app"`, `button "Web Canvas"` and one button per installed app (bundled apps such as `Calculator`, `Todo`, `Chess`) appear, paginated with `Go to page N of M`.
- **Search.** Fill `textbox "Search apps"` with `calc`. Only `Calculator` remains among app buttons.
- **Web Canvas.** Click `button "Web Canvas"`. The presentation switches to Web Canvas; capture it as Web Canvas evidence, not Web Desktop.
- **Close launcher.** Press `Escape` or click `button "Close App Launcher"`. The launcher disappears.

## Gotchas

- The launcher shows `status` "Shared apps are unavailable." with `Retry` locally because there is no platform; that is expected, not a regression.
- `Computer list unavailable` in the top bar is expected locally (no platform runtime list).
- Clerk keyless mode shows a "Configure your application" popover bottom right. It is local-only noise; do not report it.
- Settings opens as a full-screen overlay that intercepts clicks on Desktop icons. Close it (`button "Close settings"`) before driving another app.
