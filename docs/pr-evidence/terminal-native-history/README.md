# Native terminal history synchronization

Zellij handles mouse-wheel history inside its native buffer; xterm's local scrollback counters therefore do not describe that history. The shared rail now reads native above/below/visible-row counts and sends absolute seek requests to that same buffer. Only the current input owner may seek.

## Validation

- 161 focused UI, transport, runtime and gateway tests passed. New coverage includes geometry, drag coalescing, ownership, unavailable-query recovery, reconnect cleanup, permission preservation, symlink rejection, artifact hashes, and a delayed query that must not block typing/pings.
- Real Zellij 0.44.3 integration passed using an isolated home and real node-pty attachment: native mouse wheel, top/line31/bottom seek, and output appended while viewing history.
- Three Chromium renderer integrations passed: actual Web Desktop, Web Canvas at 0.75 zoom, and Electron Desktop components with synthetic native protocol responses. One native Electron integration also passed. They verify capability negotiation, polling, native seek, observer rejection, and polling cleanup after unmount.
- Combined full-suite validation: 16,045 passed, 30 failed, 50 skipped. All 30 failures were independently reproduced on unchanged main. Latest sizing-lease corrections additionally pass 66 combined runtime/socket/CLI tests; no clean full-suite claim.
- Repository typecheck, runtime build, Electron production build, production shell build (CI test Clerk key), and pattern scan (0 violations) passed.
- Rust 1.98.1 locked build completed; shipped asset/source hashes are tested. Full repository suite is tracked in the PR description.
- Latest React Doctor 0.9.14 changed-scope audit: Electron has zero findings; shell has no introduced errors and one complexity warning with the exact same location and metrics on unchanged main. Full-project baseline debt is explicitly tracked by [#1763](https://github.com/HamedMP/matrix-os/issues/1763).

## Surface matrix

| Surface | Evidence |
| --- | --- |
| Web Desktop | Real component + xterm/protocol fixture |
| Web Canvas | Same component at 0.75 zoom |
| Electron Desktop | Native Electron + real component/xterm/protocol fixture |
| Web Mobile | Shared protocol helper; native rail is not newly enabled on touch-only layout |
| Native Mobile | No custom rail added. Local gate failures reproduce main; no connected phone is available. Physical-device acceptance is explicitly deferred to [#1764](https://github.com/HamedMP/matrix-os/issues/1764), not claimed as passed. |

The screenshots show renderer/observer behavior with synthetic text, not real native-history content. macOS may hide the scrollbar thumb while idle. Real native history is checked independently by the Zellij integration test.

![Web Desktop](native-history-web-1.png)
![Web Canvas](native-history-web-0.75.png)
![Electron Desktop](native-history-electron-1.png)

## Human Review

The requester passed fullscreen sizing, native scrolling and deletion feedback on the combined Preview / Electron Desktop and authorized merge after review and CI. Later review corrections have runtime/socket/CLI regression coverage. Reproduction steps: in a disposable terminal, print 200 numbered lines, use the mouse wheel to view earlier output, drag the rail to the top/middle/bottom, and confirm thumb position follows the same history. Append delayed output while scrolled up, switch tabs and reconnect. Repeat in Web Desktop, Web Canvas and Electron Desktop. An observer must not move shared history until choosing Continue here. Confirm typing remains responsive during a cold native bridge startup.

Validation uses the disposable #1760 Preview; no production rollout is included. This branch includes fullscreen grid sizing from #1758 and the plugin prerequisite #1759.
