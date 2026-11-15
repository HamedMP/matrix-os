# Running shared app icon in the web dock — ENG-29

Ticket: https://linear.app/matrix-os/issue/ENG-29/ship-secure-collaboration-and-sharing-across-matrix-os
Depends on: [shared-app-presentation.md](shared-app-presentation.md) (PR #3361, owner name and artwork contract)

## Defect

A running shared app showed a generic window glyph in the Web Desktop taskbar. The cause:

- Shared windows use the path `__shared-app__:<scopeId>`, which never matches the recipient's app catalog.
- Every dock, taskbar, and window-chrome consumer looked icons up only in that catalog.
- The miss fell back to the default `LayoutGrid` appearance.
- Web Canvas did not show visible shared windows in its dock at all. Its minimized entries and the XP and Win11 taskbars also lost the artwork.

## Design

- `windowAppEntry(window, apps)` (`shell/src/lib/window-app-entry.ts`) is the single window→launcher identity used by every consumer:
  - Web Desktop taskbar and header previews (`WebDesktopSurface`).
  - Web Canvas dock running/minimized entries (`DockWindowIcons`, extracted from `Desktop.tsx`).
  - Canvas window chrome (`CanvasRenderer`).
  - XP and Win11 taskbars.
- A window with a `sharedAppTarget` resolves only through #3361's `sharedLauncherAppEntry(target)`, which gives the owner's presentation name, `iconUrl`, and the target. It resolves only when the target's window path matches the window. Shared windows therefore never borrow artwork from the recipient's own app with the same slug or from a system app with the same name.
  - Identical slugs from different owners stay distinct, because the path is the owner's `scopeId`.
- Every other window keeps the existing catalog match (exact path or `path:` prefix).
- Shared entries keep the launcher's shared badge. Without artwork, or after an image error, they show the owner's name initial. Artwork renders only through `<img>`; SVG is never inlined.

## Lifecycle

- Minimize, restore, close, and reopen re-derive the entry from the window's own target, so the same artwork stays with that window.
- Shared windows are intentionally ephemeral and never written to the saved layout, so a reload restores only owner windows, which keep their catalog artwork.
- Focus, minimize, and restore actions and the running indicator are unchanged. Win11 groups shared windows per share, not under one `__shared-app__` bucket.

## Security

There is no new metadata API, artwork store, or owner-file URL. The icon is #3361's same-origin, member-gated, digest-bound `/api/collaboration/shared-apps/:scopeId/artwork/:sha256` path.

## Acceptance

| Actor and state | Action | Observable completion | Failure/recovery | Boundary | Surface and test |
| --- | --- | --- | --- | --- | --- |
| Member, shared app with owner art | Launch from launcher | Dock shows the owner's artwork and shared badge, running dot | Missing/broken art: name initial | #3361 member-gated artwork | Web Desktop: `tests/shell/running-window-app-identity.test.tsx` |
| Member | Minimize, restore, close, reopen | Same artwork each time | — | Window's own target | Web Desktop, Web Canvas: same suite |
| Member with own same-slug app and shared "Chat" | Open all | Each keeps its own artwork; system Chat keeps its icon | — | `scopeId` path | Same suite |
| Member | Reload | Owner windows restored with catalog art; no stale shared entry | — | Layout excludes shared windows | Same suite |
| Member, XP/Win11 design | Open two shared apps | One artwork per share; icon focuses its own window | — | — | Same suite |
| Member, Electron Desktop | Launch shared app | Taskbar tab shows owner artwork; own same-slug app keeps its icon | Image error: surface glyph fallback | Platform-authenticated artwork | Electron Desktop: `tests/desktop/app-launcher.test.tsx` |

## Surfaces

- Web Desktop and Web Canvas: changed.
- Web Mobile: unchanged. The open-app header shows the window title, and the launcher already uses #3361's presentation.
- Electron Desktop: changed. The same defect existed: shared app tabs had no icon, so `SurfaceIcon` fell back to `LayoutGrid`.
  - `SurfaceIcon` now derives a shared tab's artwork from its `sharedAppTarget` via `sharedAppPresentation(target, platformHost)` on every render. A host or account change never reuses a URL captured at launch.
  - A changed URL remounts the image and clears any earlier failure, and a 404 falls back to the surface glyph.
  - Tab identity includes the `scopeId`, so a same-slug own app keeps its own icon.
  - Test: `tests/desktop/app-launcher.test.tsx`.
- Native Mobile: N/A. There is no shared-app launcher or dock (see launcher-followup). Reviewer approval required.
