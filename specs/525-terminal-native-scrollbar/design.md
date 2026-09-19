# Native terminal history bridge (#1745)

Problem: Zellij wheel scrolling redraws the viewport without changing xterm baseY/viewportY. The local rail therefore cannot describe native history.

Spike (real official Zellij 0.44.3, disposable local session): a small WASI plugin using get_pane_scrollback(pane, true) returns above=59, below=0, rows=46 at bottom; above=0, below=59, rows=46 at top; restoring bottom returns the original metrics. First pipe to a newly loaded plugin may time out while permission initialization completes; later pipes succeed. Zellij 0.44.3 page_scroll_down_in_pane_id moves get_content_rows rows; page_scroll_up differs (outer rows minus one), so do not assume symmetry.

Implementation design:
- Ship a small versioned, reproducibly built zellij-tile=0.44.3 WASI plugin under packages/terminal-runtime/assets. Source and lockfile accompany the artifact. Host bundle already includes packages.
- Plugin reports native above/below/viewport row counts; it never returns terminal contents. Absolute scroll requests use top/bottom shortcuts and bounded page-down + single-line operations, returning actual position so a large seek can continue in another batch. Each batch at most 256 operations; frontend coalesces drag targets and continues only toward its latest target.
- Runtime invokes only its internal workspace/pane IDs and immutable plugin path, with bounded command time/output. Read metrics are coalesced per attachment (bounded existing registry). Plugin permission entries must preserve existing owner permissions and reject symlinks; never rewrite arbitrary owner config.
- Add validated scroll-query/scroll-to websocket frames and scroll-state response. Query is read-only; scroll-to must use the existing owner/writer checks, including live lease recheck. No client-supplied native pane IDs or filesystem paths.
- Desktop/Web clients poll only while attached, pause on disconnect/unmount, coalesce outstanding queries, and reset state on session change. The unified rail uses native metrics when available, falling back to local xterm only when native support is absent. Observer native rail must not mutate shared native history; local canonical clipping remains scrollable.
- Wheel/fullscreen application input still goes through native mouse protocol. Rail drag uses the native bridge. Validate actual native wheel and drag against identical metrics; do not substitute pure xterm fixtures.

Tests first: frame validation/authority, native rail thumb and drag, native bridge bounds/coalescing/cleanup, real plugin history seek and append while scrolled, Web Desktop/Web Canvas/Electron renderer wiring. Native Mobile currently has no custom rail; protocol additions optional.

Delivery: separate PR from #1756. Full product Human Review required. Add public-safe docs and a separate private site docs PR when the product behavior contract is ready.
