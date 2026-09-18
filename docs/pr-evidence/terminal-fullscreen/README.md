# Terminal viewport sizing

The acknowledged desktop writer declares the actual viewport grid at the configured font. Previously a 120x36 grid stayed at 120x36 when the viewport expanded because clients sent soft resize requests and local scale was capped at one.

## Validation

- 184 focused renderer, socket, runtime and scrollbar tests passed; includes a Unix-socket notification from a resize on another tab.
- 7 Chromium renderer scenarios passed: writable growth/shrink in Web Desktop, Web Canvas and Electron Desktop; observer fit/pan, selection and history in those surfaces plus Web Mobile.
- 2 native Electron renderer scenarios passed using an isolated profile, real xterm and synthetic terminal frames.
- Real Zellij 0.44.3 watcher sizing smoke passed. This independently checks PTY sizing; it does not replace full product Human Review.
- Repository typecheck, pattern scan (zero violations), production shell build (CI test Clerk key), and Electron production build passed.
- React Doctor 0.0.29: existing large-component/compiler findings remain (Electron 4 warnings; shell 17 compiler errors and 5 warnings). Latest React Doctor only requests installation, so the runnable pinned scanner was used. Production TypeScript/build checks pass.

## Surface matrix

| Surface | Result |
| --- | --- |
| Web Desktop | Writable grid fills enlarged/reduced viewport; observer stays soft |
| Web Canvas | Same behavior under 0.75 parent zoom |
| Electron Desktop | Same behavior in Chromium fixture and native Electron |
| Web Mobile | Existing canonical soft fit/pan regression passes |
| Native Mobile | No renderer changes; soft proposals remain non-mutating in runtime tests; device acceptance not run |

![Electron expanded grid](electron-expanded.png)
![Web Desktop expanded grid](web-desktop-expanded.png)
![Web Canvas expanded grid](web-canvas-expanded.png)

## Human Review

Use the matching gateway/runtime and Electron Desktop build. Open a disposable terminal, run `stty size`, enlarge/fullscreen the window, run it again, then shrink it. Rows and columns should follow the usable viewport, with no stale wide blank strip. Reconnect at the same size and confirm sizing remains correct. Open a second device as observer: it should scale/pan without changing the writer's dimensions. Repeat in Web Desktop and Web Canvas.

Native Zellij scrollbar synchronization is tracked separately in #1745; the local-history fixtures above are not evidence that native history is synchronized.
