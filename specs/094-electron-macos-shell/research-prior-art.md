# 094 Prior Art: SwiftUI Prototype Lessons, Gateway Surface, and Inspiration Inventory

Companion to `spec.md`. Records why this rebuild exists, what the SwiftUI prototype (specs 086/088, branches 090/091/092) proved, the verified gateway contract the Electron app inherits, and the concrete UX patterns borrowed from the OpenAI Codex app and SlayZone.

## 1. Lineage

| Stage | What happened |
|---|---|
| 086-macos-native-shell | Original spec: thin-client macOS app ("Operator"), kanban of VPS sessions, device auth, terminal over gateway WS. US1–US3 built and verified live. |
| 088-macos-dev-experience | Raised the bar to VS Code-class terminal/editor/workspace. Concluded: Monaco-in-WebView is the right editor long-term; SwiftTerm baseline terminal; Ghostty embedding not viable yet. |
| 090-appmodel-terminal-registry | Mechanical split of the AppModel god-file (2593→217 lines). |
| 091-macos-native-session-cookies | Fixed the hosted-shell auth loop (non-destructive recovery), WKWebView cookie-pair handoff, persistent data store + stale Clerk cookie cleanup, terminal focus/resize fixes. |
| 092-macos-split-app-workspace | Reconciled 090 split + 091 features (AppModel 2593→233, Workspace 2283→104), @Observable migration, native app launcher, native Hermes chat, session-merge fix, 207→229 tests. Local-only, never pushed. |

Final prototype size: ~14.2K Swift source + 4.4K tests across 69 files. It works end to end: device sign-in → board → live zellij attach → Hermes chat → bridged apps.

## 2. Why Electron (decision record)

The prototype proved the **product** (thin client over the per-user VPS) and disproved the **platform fit**. Recurring friction, all documented in working notes and commit history:

1. **WKWebView session handoff** consumed multiple debugging waves: dual-cookie exchange (`matrix_app_session` + `matrix_native_app_session`), URLSession→WKHTTPCookieStore transfer, stale Clerk cookie shadowing, persistent-store regressions. In Electron the hosted shell runs in real Chromium with a real cookie jar per partition — the entire handoff problem class shrinks.
2. **Editor fragility**: custom TextKit/NSTextView editors regressed repeatedly (blank panes, one-char-per-line JSON); CodeEdit required exact-version pinning. The 088 conclusion was already "Monaco-in-WebView" — i.e., the web stack. Electron makes Monaco first-class instead of embedded-in-Swift.
3. **Terminal ceiling**: SwiftTerm is solid but the web shell already runs `@xterm/xterm` (+ webgl/search/serialize addons) against the same gateway WS. One terminal stack across web and desktop ends the duplicate-renderer tax. Ghostty embedding remains unavailable (no stable embedding API).
4. **Agent verifiability**: UI regressions shipped because the coding agent could not screenshot the running SwiftUI app (macOS Screen Recording permission). Electron is drivable by Playwright/CDP — every UI change becomes self-verifiable in CI, aligning with the repo's mandatory screenshot-evidence rule.
5. **Stack unification**: the repo is a TypeScript monorepo (Zod 4, Vitest, shared gateway types, react-doctor CI). The Swift target sat outside all tooling, tests, and review automation. Codex app and SlayZone — the two inspiration apps — are both Electron, which is evidence the UX bar is reachable on this runtime.

Known Electron costs, accepted with mitigations: memory footprint (mitigated by the LRU workspace policy and SC-012 budget), "web feel" risk (mitigated by US6 native-conventions story and the design system), update/signing pipeline (rides existing release channels).

What does NOT carry over: nothing about the thin-client contract changes. Same auth, same endpoints, same protocols. One notable advantage is retained rather than lost: a desktop app controls its network layer, so **WS header bearer auth (086 FR-015a) still applies** — no query-token fallback needed (unlike browsers).

## 3. Verified gateway surface (the inherited contract)

Verified live by the prototype. HTTP via platform proxy, bearer header; `?runtime=<slot>` selects the VM.

### HTTP

| Route | Method | Purpose |
|---|---|---|
| `/api/auth/device/code` | POST | Start device auth (requires `clientId`) |
| `/api/auth/device/token` | POST | Poll for token (428 pending / 429 slow down / 410 expired) |
| `/api/auth/app-session` | POST | Hosted-shell session handoff (must yield BOTH cookies) |
| `/api/workspace/projects` | GET | Projects list |
| `/api/projects/{slug}/tasks` | GET/POST | Board read / task create |
| `/api/projects/{slug}/tasks/{id}` | PATCH/DELETE | Task update / delete |
| `/api/terminal/sessions` | GET | Zellij session list |
| `/api/sessions` | GET | Workspace session records (orchestrator; merge rules apply — see lesson L6) |
| `/api/files/list`, `/api/files/tree` | GET | Directory listing / tree |
| `/api/files/{path}` | GET/PUT | File read / write |
| `/api/projects/{slug}/branches` / `prs` / `worktrees` | GET | Git read surface |
| `/api/projects/{slug}/previews` | GET | Artifacts/previews |
| `/api/system/info` | GET | Runtime resources (CPU/mem/disk/net) |
| `/api/apps` | GET | Matrix app catalog |
| `/api/apps/{slug}/session-token` | POST | Bridged app launch token (relative `launchUrl`, resolve against gateway base, reject foreign origins) |

Known route gotchas from the prototype: project slug must be real (`matrix-os`, not `default` → 404); `POST /api/sessions {kind:shell}` returns 400 (orchestrator is agent-only) — create terminals via the WS auto-create path.

### WebSocket

| Route | Purpose | Protocol notes |
|---|---|---|
| `/ws` | Kernel (Hermes) + events | Send `{type:"message", text, sessionId?, requestId?}`, abort via `{type:"abort", requestId}`; receive `kernel:init/text(delta)/tool_start/tool_end/result/error/aborted`, `session:switched`. Schema: `packages/gateway/src/ws-message-schema.ts`. Reducer contract mirrors `shell/src/lib/chat.ts` (delta accumulation, tool-split bubbles). |
| `/ws/terminal/session?session=<name>&fromSeq=<n>` | Attach existing session | Frames in: `input`, `resize`, `detach`. Frames out: `attached`, `output{seq,data}`, `exit{code}`, `resize-change`, `replay-evicted`, `error`. |
| `/ws/terminal?cwd=<path>` | Auto-create session | Same frame protocol. |

## 4. Lessons ledger (each is a 094 requirement, not advice)

| # | Lesson (paid for in the prototype) | 094 consequence |
|---|---|---|
| L1 | Hosted-shell 401 once triggered native sign-out → infinite redirect/sign-out loop | FR-061: embedded-surface auth failure can never touch the native principal; one retry then inline prompt |
| L2 | App-session handoff silently failed when only one of the two cookies landed | FR-060: verify both cookies before declaring handoff success |
| L3 | Stale Clerk cookies shadowed fresh native sessions | FR-060: clear known-stale auth cookies before each embedded load |
| L4 | Terminal "keep-alive" kept one WS per background session → zellij client pileup on the VPS (~6 stale clients) | FR-022: single active attachment; cached buffers for instant switch |
| L5 | `session_not_found` was retried forever → permanent "connection lost" | FR-023: fatal results stop retrying; recreate CTA |
| L6 | Merging orchestrator UUID records into the attach path caused the retry storm in the first place | FR-021: only genuinely attachable sessions enter the attach path |
| L7 | Unthrottled resize flooded zellij and dropped clients | FR-024: settle-style resize coalescing (prototype used 90/220/900 ms tiers) |
| L8 | Replay of evicted sequence ranges would duplicate output if retried | FR-025: accept the gap, attach at tail, mark the gap |
| L9 | Fast task-switching let the slower attach win | Edge case: generation guard on open requests |
| L10 | Raw gateway/DB error text nearly reached the UI repeatedly | FR-080 + display-boundary allowlist (double defense) |
| L11 | Board reload-on-every-visit infuriated the user | FR-013: stale-while-revalidate, skeleton only on first load |
| L12 | Unit tests + launch checks missed three render bugs in one wave; agent couldn't screenshot the app | CI requirement: Playwright-driven screenshot verification of the running app (now possible) |
| L13 | God files (AppModel 2593 lines, Workspace 2283) made parallel agent work impossible until split | Plan requirement: module boundaries from day one (state stores per domain, no coordinator god-object) |
| L14 | ZStack-cached webview overlapped the editor's NSView (blank editor) | Panel keep-alive must suspend, not overlay; bounded live-embed count (FR-064/resource rules) |
| L15 | Subagent UX-audit claims were stale/wrong vs the code | Process: verify audit claims against code before acting |

## 5. Inspiration inventory

### From the OpenAI Codex app (agent-first desktop)

| Pattern | Adoption in 094 |
|---|---|
| Sidebar of parallel agent threads with live status | US2 / FR-031..032 |
| Composer launches agent work from anywhere | US2 / FR-031, palette-integrated (US6) |
| Needs-attention state + native notifications + click-through focus | FR-035, FR-070..071 |
| Diff review as the ship gate; comment → re-prompt agent | US4 / FR-051, FR-053 |
| Environment targeting per run (local/cloud) | Runtime-slot selection per profile (FR-005); per-task worktree scoping (FR-052) |
| Background runs continue when window closed | Threads live on the VPS; app reattaches (thin-client advantage, free) |

### From SlayZone (task-centric workspace)

| Pattern | Adoption in 094 |
|---|---|
| Kanban projects with per-project statuses, tags, priorities, templates | FR-010..015 (templates: status/priority defaults at create; full template system can phase in) |
| Task detail = panel strip: agent/terminal, browser, editor, git, artifacts, processes, settings | US3 / FR-040..045 |
| Panel sizing model (`px|fr|pct`, min/max, persist per task, global order) | FR-040; concrete model reused at plan time |
| PTY session states incl. `attention` (AI ready for input) | Thread status model (FR-031); informs notification triggers |
| `slay pty submit/wait/buffer` orchestration loop | Matrix CLI/MCP already covers this against the same gateway (086 US6); task terminals export task context env var |
| Create-task modal with "Create" vs "Create + open" | FR-012 |
| Web panels (pin external tools per task) | Deferred — candidate for the browser panel's pinned URLs, not v1 scope |
| Right-click task context menu (status/priority/tags/snooze/archive) | Board interaction detail for design phase under FR-011/015 |
| Auto-title tasks from conversation | Deferred; Hermes-side capability, not client scope |

### Matrix OS-specific (no analog in either app)

- Hosted Canvas shell embedded as a surface (FR-060..061).
- Bridged Matrix apps with session-token launch (FR-062..063).
- Everything-on-VPS data model: zero-loss machine portability (SC-008).
- Channels/integrations/cron settings parity (FR-065).

## 6. Open gateway deltas (carried into spec Dependencies)

| Delta | Blocks | Notes |
|---|---|---|
| Task event push on `/ws` | FR-014 live board sync | Today REST-poll only (`/api/workspace/events`) |
| Kill zellij session by name | FR-026 close/terminate | Known prototype blocker ("× deactivates instead of closing") |
| Diff content endpoint | FR-050..051 review pane | Lists exist; diff bodies don't |
| Desktop release feed (signed) | FR-091 auto-update | Extend release-channel infra with desktop artifact type |
| Command-completion attention signal | FR-070 (best effort) | Degrade gracefully if absent |
