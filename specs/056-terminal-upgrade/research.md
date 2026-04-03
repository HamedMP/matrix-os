# Research: Terminal Upgrade (Spec 056)

## R1: Ring Buffer Design

**Decision**: Custom circular buffer with monotonically increasing sequence numbers (never wrap), byte-size-based eviction of oldest chunks.

**Rationale**: Sequence numbers that never wrap simplify gap detection — clients compare `lastSeq` to first available seq. Byte-based eviction (not count-based) ensures the 5MB cap is precise regardless of chunk sizes. Standard circular buffer with head/tail pointers.

**Alternatives considered**:
- Fixed-size chunk slots (wastes space with variable PTY output sizes)
- npm `circular-buffer` package (unnecessary dependency for ~60 lines of code)
- Wrapping sequence numbers (adds modular arithmetic complexity for no benefit — sessions don't live long enough to overflow a JS number)

## R2: Session Registry Lifecycle

**Decision**: In-memory Map of sessions with file-based metadata persistence. Sessions survive WebSocket disconnect but not gateway restart. Max 20 sessions with LRU eviction of orphaned sessions.

**Rationale**: Gateway restart kills all PTY processes (OS behavior), so reconnecting to a dead PTY is impossible. Persisting metadata enables cleanup of stale entries on startup. 20-session cap with orphan eviction balances resource usage — active sessions are never evicted.

**Alternatives considered**:
- tmux/screen for PTY persistence across restarts (adds system dependency, complexity far exceeds benefit for single-user OS)
- SQLite for session metadata (overkill for max 20 entries, file-based is simpler per Constitution V)
- No persistence (stale metadata file would grow; startup cleanup needs the file)

## R3: WebSocket Protocol Extension

**Decision**: Add `attach`, `attached`, `detach`, `replay-start`, `replay-end` message types. Add `seq` field to output messages. Backward-compatible — existing `?cwd=` param auto-creates session.

**Rationale**: Keeps existing clients working. New clients can opt into session persistence by sending `attach` messages. Sequence numbers enable gap detection and partial replay.

**Alternatives considered**:
- Breaking protocol change (would break existing Terminal.tsx standalone component)
- Separate WebSocket endpoint for persistent sessions (complicates routing)

## R4: xterm.js Addon Compatibility

**Decision**: Use `@xterm/addon-webgl`, `@xterm/addon-search`, `@xterm/addon-serialize` — all official addons compatible with `@xterm/xterm@^6.0.0`.

**Rationale**: Official addons maintained by the xterm.js team. WebGL addon has automatic canvas 2D fallback. Search addon provides `findNext`/`findPrevious`/`clearDecorations` API. Serialize addon loaded but no UI (future export feature).

**Alternatives considered**:
- Custom WebGL renderer (massive effort, no benefit over official addon)
- Browser find (Ctrl+F) instead of addon search (doesn't work inside xterm canvas)

## R5: Terminal Theme Mapping

**Decision**: Curated ANSI palettes (One Dark, One Light, Catppuccin Mocha, Dracula, Nord, Solarized, GitHub) mapped to OS theme slugs. Unknown themes fall back to luminance detection (existing behavior).

**Rationale**: The existing luminance-based approach works but produces suboptimal colors for known themes. Explicit mapping gives crisp, tested palettes for the built-in themes while preserving the fallback for custom themes.

**Alternatives considered**:
- Auto-generating ANSI colors from theme primary/secondary (unreliable contrast)
- Separate terminal theme picker (spec explicitly excludes this as non-goal)

## R6: Clickable Link Detection

**Decision**: Custom `ILinkProvider` implementation registered via `terminal.registerLinkProvider()`. URL regex + file path regex with extension whitelist. Join wrapped lines before matching.

**Rationale**: xterm.js's built-in web links addon is limited (only URLs, no file paths). Custom provider handles both URLs and file paths with `:line:col` suffix. Extension whitelist avoids false positives on random text that looks like paths.

**Alternatives considered**:
- `@xterm/addon-web-links` (no file path support)
- Post-processing terminal output (can't provide hover/click interaction)

## R7: Frontend Terminal Caching

**Decision**: Module-level `Map<string, CachedTerminal>` keyed by paneId. Cache stores Terminal instance, addons, WebSocket reference, lastSeq, and sessionId. Tab switch detaches DOM, preserves everything.

**Rationale**: Module-level Map is simplest approach. No size cap needed — bounded by open pane count (max 4 per tab, reasonable tab count). WebSocket stays alive during tab switch so no output is missed.

**Alternatives considered**:
- Zustand store for cache (over-engineering — cache is an implementation detail of TerminalPane, not app state)
- Destroying and recreating WebSocket on tab switch (loses output during switch, wastes bandwidth)
