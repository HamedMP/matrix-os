# Matrix OS Context

Matrix OS is a Web 4 operating system. The AI kernel, gateway, platform, and app data model are headless; the shell is one renderer over those capabilities.

## Shell Modes

The production shell has multiple renderers over the same window/app state:

- **Canvas mode is primary.** New user-facing shell features must work on Canvas first. Canvas uses `CanvasRenderer` and `CanvasWindow`, with spatial pan/zoom and embedded app windows.
- **Desktop mode is compatibility.** Desktop uses the classic floating-window renderer in `Desktop.tsx`. It must keep working, but it is not the first design target.
- Other modes such as ambient/dev may exist, but they should not be the only place a feature works.

Any built-in app or shell feature must be wired wherever windows are rendered. If a path like `__workspace__`, `__terminal__`, `__file-browser__`, or `__chat__` is handled in Desktop mode, it must also be handled in Canvas mode. Never let built-in `__...` paths fall through to `AppViewer` or `/files/{path}`.

## Feature Rule

When adding or fixing shell functionality:

1. Implement and verify Canvas mode first.
2. Verify Desktop mode still works.
3. Add regression coverage for shared path/routing helpers when possible.
4. Check browser console/network for accidental `/files/__...` requests, stale 404s, auth regressions, and canvas persistence errors.
