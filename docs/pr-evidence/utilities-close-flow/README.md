# Utilities UI and close-flow evidence

Captured with the built Utilities application in local test environments. All visible input, app lists, identity and session data are synthetic; no customer data is included.

## Web Canvas, Web Desktop and Web Mobile

The actual Web frontend opens the built app in its sandboxed iframe. The local harness supplies app/session/layout/settings responses and disables the unavailable realtime connection. The screenshots show the appropriate presentation, illustrated launcher icon and close confirmation. Trusted keyboard input is checked before closing. **Keep working** must retain the same iframe element and exact draft; confirmed **Close Utilities** must remove the iframe.

Browser checks use the already installed Google Chrome executable. No browser is downloaded. These local checks do not prove an installed customer runtime or Native Mobile behavior.

- [Web Canvas confirmation](web-canvas-close.png)
- [Web Desktop confirmation](web-desktop-close.png)
- [Web Mobile confirmation](web-mobile-close.png)
- [Utilities launcher](utilities-launcher.png)

## Electron Desktop

The installed Electron runtime opens the built native shell, preload and Utilities app in a real WebContentsView. The local gateway and auth profile are disposable fixtures. The test checks actual controlled typing, cancellation retaining the same native view and draft, Close all cancellation, and explicit confirmation destroying the native view. This is an Electron capture, not a browser screenshot presented as Electron evidence.

- [Electron Desktop confirmation](electron-desktop-close.png)
- Executable regression: `tests/e2e/desktop/utilities-close.e2e.test.ts`.

Native Mobile retains the documented save-before-navigation limitation. Real customer runtime and rollout checks remain separate.
