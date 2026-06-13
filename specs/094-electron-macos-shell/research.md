# Research: Electron macOS Shell (Operator)

Phase 0 output. Resolves all technical unknowns for the plan. Sources: live code survey of
`shell/` (web shell), `packages/gateway/`, the 092 SwiftUI prototype, and SlayZone
(architecture study only — SlayZone is GPLv3; we learn patterns, we do not copy code).

## R1. Runtime & toolchain

**Decision**: Electron (current stable line) + electron-vite + electron-builder, React 19,
TypeScript strict, Tailwind v4, Zustand v5, Vitest, Playwright (`_electron`) for e2e.

**Rationale**: Mandated by the spec (user decision). electron-vite gives main/preload/renderer
as separate Vite builds with HMR; electron-builder handles mac signing/notarization/auto-update
and is the path SlayZone ships with (proof the pipeline works for this app shape). React 19 +
Tailwind v4 + Zustand match the web shell, maximizing code reuse and keeping react-doctor CI
applicable. pnpm `minimumReleaseAge: 10080` applies — all chosen versions must be ≥7 days old.

**Alternatives considered**: Electron Forge (weaker vite story than electron-vite); Tauri
(rules out reusing Chromium cookie-partition behavior for the hosted-shell embed, weaker
WebContentsView equivalent, new IPC surface in Rust); plain webpack (no reason).

## R2. Process & security architecture

**Decision**: Three tiers.

1. **Main process = trusted core.** Owns: credential (Electron `safeStorage`, encrypted at
   rest in `userData`), device-auth flow, connection profile, notifications, updates,
   single-instance, window management, embed partitions, app-session handoff.
2. **Renderer = bundled app UI.** `contextIsolation: true`, `sandbox: true`,
   `nodeIntegration: false`. Loads only bundled content. Talks to main exclusively through a
   zod-validated, typed IPC contract exposed by one preload (`contextBridge`).
3. **Embedded remote content** (hosted Canvas shell, bridged Matrix apps) renders in
   `WebContentsView`s owned by main, each in an isolated `persist:` partition, **no preload IPC
   exposure**, navigation gated by an origin allowlist, `window.open` denied (external links →
   system browser).

**Gateway auth without giving the renderer the token**: main installs a
`session.defaultSession.webRequest.onBeforeSendHeaders` hook that injects
`Authorization: Bearer <token>` **only** for requests whose URL origin equals the active
gateway origin (platform proxy). This covers both `fetch()` and WebSocket upgrades (the upgrade
is an HTTP request), so the 086 FR-015a header-auth contract is preserved and the renderer
never reads the credential (FR-002/FR-003). Embed partitions do NOT get the hook — remote
content can never ride the native principal (L1 structural fix).

**Rationale**: Renderer-direct WebSockets avoid proxying high-volume terminal output over IPC
(SlayZone pays that IPC tax because its PTYs are local; ours are remote — the renderer can hold
the socket directly). Verified against `packages/gateway/src/auth.ts:215-273`: Authorization
header is accepted on WS upgrades; query-token is only a browser fallback we don't need.

**Alternatives considered**: WS-in-main + IPC frame proxy (extra copy per output frame, more
moving parts, no security gain given header injection is origin-scoped); query-token WS auth
(weaker: token lands in URLs/logs); keytar (unmaintained; `safeStorage` is built in and
Keychain-backed on macOS).

## R3. Terminal stack

**Decision**: Reuse the web shell's xterm stack: `@xterm/xterm` + fit/search/webgl/serialize
addons, the terminal theme palettes (`shell/src/components/terminal/terminal-themes.ts`), and
the Nerd-Font stack (`terminal-fonts.ts`). Write a new, small `ShellSocket` client implementing
the prototype-proven protocol (it is ~300 lines, and the web shell's TerminalPane couples
socket + UI in one 1,337-line file — we keep the proven constants, not the coupling, honoring
lesson L13).

**Protocol constants (verified against gateway `shell/ws.ts` + 092 `ShellWSClient.swift`)**:

- Attach: `GET /ws/terminal/session?session=<name>&fromSeq=<n>` (+`&runtime=<slot>` when not primary).
- Live-tail sentinel `fromSeq = 9_007_199_254_740_991` (server replays last 50 events).
- Client frames: `input{data≤65536}` (chunk larger pastes), `resize{cols 1-500, rows 1-200}`,
  `detach`, `ping`.
- Server frames: `attached{session,state,fromSeq}`, `output{seq,data}`, `exit{code}`,
  `error{code,message}`, `pong`, `replay-evicted{fromSeq,nextSeq}` (legacy path; the named
  route currently skips eviction markers — client must also tolerate silent gaps).
- Fatal error codes (never retry): `session_not_found`, `invalid_request`, `attach_failed`.
- Backoff: base 0.5s × 2^attempt, cap 30s, jitter 0.5, surface "connection lost" after 2
  attempts but keep trying capped (prototype policy).
- Resize coalescing: steady 90ms, startup 220ms, post-attach settle 300ms, no-resize fallback 900ms.
- Scrollback ring: 5,000 lines per terminal.
- Single active attach per session (L4): an attach manager holds at most one socket; switching
  away detaches and snapshots the buffer via SerializeAddon for instant restore; cached
  (detached) terminals capped LRU 8.

**Session merge rule (L6, verified in 092 `AppModelTypes.swift`)**: attachables = zellij names
from `GET /api/terminal/sessions` ∪ workspace records from `GET /api/sessions` that carry a
non-empty `runtime.zellijSession`. Orchestrator UUIDs never enter the attach path; keep an
alias map `taskLinkedSessionId → zellijName`.

## R4. Kernel (Hermes) protocol & agent threads

**Decision**: Reuse the web shell's reducer semantics verbatim — port
`shell/src/lib/chat.ts` (`reduceChat`, `groupMessages`, tool-split bubbles) and the
`useSocket` connection-state machine. One multiplexed `/ws` connection in the renderer;
per-thread `requestId` routes events to thread transcripts. Outbound:
`{type:"message", text, sessionId?, requestId}`; abort `{type:"abort", requestId}`. Inbound:
`kernel:init/text/tool_start/tool_end/result/error/aborted`, `session:switched`,
plus `task:created`/`task:updated` events already broadcast on `/ws` (partial FR-014 coverage:
created+status today; full update push is a gateway delta).

Transcript cap 500 messages per thread; display-boundary error allowlist (cap 300 chars, reject
strings containing `/home/`, `enoent`, `postgres`, `sql`, `stack`, etc. — 092 rule).

## R5. Editor

**Decision**: Monaco, bundled locally via vite worker imports (no CDN; CSP forbids). Multiple
models (one per open file), dirty tracking, find/replace built in. Conflict-safe save: stat the
file (`/api/files/stat`) before `PUT`; if server mtime ≠ mtime-at-load → warn (gateway PUT is
unconditional overwrite — verified; client must provide the guard).

**Alternatives considered**: CodeMirror 6 (lighter, but 088 already concluded Monaco-class is
the bar: VS Code keybindings, minimap, multi-cursor for free).

## R6. Board, panels, palette UI libraries

**Decision**: dnd-kit (kanban drag), cmdk (command palette), Radix primitives + lucide-react
icons (match `packages/ui` and shell), custom panel-strip implementation with percent-based
sizing and per-panel min widths (SlayZone pattern, reimplemented).

Panel keep-alive rule (L14): hidden panels stay mounted but `display:none` (suspend, never
overlay); embeds are the exception — they are WebContentsViews positioned by bounds, so hiding
= removing from the window's contentView and resuming = re-adding (bounded live-embed count).

## R7. Local persistence (FR-084)

**Decision**: One small typed JSON store in `app.getPath("userData")` with atomic writes
(tmp + rename), holding: connection profile, window bounds, per-task panel layouts, recents,
appearance prefs. Credential stored separately as a `safeStorage`-encrypted blob. No SQLite, no
user work locally (thin client; Constitution I respected — the Postgres/Kysely rule governs
server persistence; client keeps only recreatable UI state).

## R8. Embedded surfaces (hosted shell + bridged apps)

**Decision**: `WebContentsView` per embed, partition `persist:hosted-shell` and
`persist:app-<slug>`. App-session handoff runs in main: `net.request` POST
`/api/auth/app-session` with bearer → parse ALL `Set-Cookie` headers → require BOTH
`matrix_app_session` AND `matrix_native_app_session` (L2) → install into the partition's
cookie jar → delete stale Clerk cookies (`__client*`, `__session*`, domain contains "clerk")
(L3) → load URL. Failure: retry once, then inline sign-in UI inside the embed surface; never
touches the native principal (L1, FR-061).

Bridged apps: `POST /api/apps/{slug}/session-token` → `{expiresAt, launchUrl}`; cache per slug
until `expiresAt - 30s` (bounded LRU); `launchUrl` must be relative and resolve to the gateway
origin, else refuse (FR-062/063).

## R9. Notifications, updates, distribution

**Decision**: Electron `Notification` API for thread attention (coalesced per thread, bounded
queue); dock badge via `app.setBadgeCount`. Updates: `electron-updater` with a **generic
provider** feed (static JSON + artifacts) so it can ride the existing R2 + release-channel
infra (dev/canary/beta/stable) — the feed itself is a gateway/platform delta; until it exists,
update checks no-op gracefully. Signing/notarization: electron-builder `hardenedRuntime` +
notarize, credentials via env at release time; not exercised in dev builds.

## R10. Testing strategy (Constitution IX)

**Decision**:

- **Unit (Vitest, root `tests/desktop/`)**: protocol clients with fake sockets (attach/replay/
  backoff/fatal-codes/resize-coalescing), chat reducer thread routing, session merge rule,
  board SWR store, error mapper allowlist, IPC schema validation, layout store LRU, launch-URL
  resolution, cookie-pair verification logic. Pure TS — no Electron import needed; Electron
  APIs behind narrow interfaces so logic is testable (mirrors the 092 test inventory, 229 tests).
- **E2E (Playwright `_electron`)**: launch app against a stub gateway (local Hono fixture),
  walk sign-in → board → terminal echo → thread stream; screenshot evidence per repo rule
  (this is the L12 fix — the agent can finally screenshot the app).
- react-doctor on the renderer project before commit (repo hard rule for React changes).

## R11. Repository layout & wiring

**Decision**: new top-level `desktop/` (workspace member; add `"desktop"` to
`pnpm-workspace.yaml`). Not under `apps/` (that namespace is for Matrix OS user apps templates
— `apps/mobile`, `apps/menu-bar` exist but mobile is its own spec surface; `desktop/` mirrors
`shell/` as a first-class client). Tests at root `tests/desktop/` per repo convention, with a
`@desktop` alias added to the root vitest config. Dev: `bun run dev:desktop` → electron-vite
dev (renderer HMR). The desktop package has its own tsconfig (strict, ESM, react-jsx).

**Code reuse mechanics**: copy framework-free modules from `shell/src` (terminal themes/fonts,
chat reducer semantics, socket-health patterns) into `desktop/src/renderer/src/lib/` with a
header comment naming the source file; extraction into a shared package is an explicit
follow-up, not this feature (avoids destabilizing the web shell in the same change).

## R12. Design system ("world-class" bar)

**Decision**: dark-first, Linear/Codex-grade. Tokens as CSS variables layered on Tailwind v4
(`@theme`), seeded from the shell's dark preset but tuned for density: 13px base UI type
(SF Pro via `-apple-system`), mono = shell's Nerd-Font stack, 8px spacing grid, 6px radius,
1px hairline borders at low alpha, two elevation tiers, 120-150ms ease-out micro-transitions,
focus rings on every interactive element (keyboard-first, US6). Frameless window
(`titleBarStyle: "hiddenInset"`) with a custom 38px drag-region titlebar hosting
runtime/connection status. All copy sentence-case, no emoji. Empty states follow the UX guide
(icon + headline + description + CTA).

## Resolved gateway-contract clarifications (vs spec Dependencies)

| Spec dependency | Research finding |
|---|---|
| Task event push (FR-014) | `/ws` already broadcasts `task:created` and `task:updated{taskId,status}` (`server.ts:319-345`); full-field update/delete push remains a delta. Client: consume what exists + SWR refresh on focus as fallback. |
| Kill session by name (FR-026) | Still missing — UI ships disabled-with-tooltip until the gateway delta lands. |
| Diff content (FR-050/051) | Confirmed missing — git panel v1 shows branches/PRs/worktrees/status lists only; diff pane lands with the delta. |
| Desktop release feed (FR-091) | Missing — updater no-ops without feed URL. |
| Device auth | Lives platform-side (not in gateway package); contract verified by 092 client: `POST /api/auth/device/code` `{clientId:"matrix-os-desktop", redirectUri}` → poll `/api/auth/device/token` (428 pending / 429 slow-down +5s / 410 expired); token `{accessToken, expiresAt(ms), userId, handle}`. |
| Files conflict detection | No server etag — client stat-before-save guard (R5). |
| Tasks optimistic concurrency | Task records carry `revision` + `updatedAt`; PATCH is last-write-wins server-side today, so client sends mutations serially per task and refreshes on conflict-suspect responses. |
