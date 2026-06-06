# Matrix OS macOS Production Launch Plan

Date: 2026-06-05
Branch: `086-macos-native-shell`
Status: launch-hardening implementation + stacked PR plan

## Current State

This slice turns the native macOS shell into the first usable launch candidate
for project/task work:

- The left side is now a real project/session panel, with a collapsible compact
  mode, larger Matrix identity, selected project, live sessions, a primary new
  task/session action, and a visible Clerk/user card.
- `Home` is represented as a first-class workspace tab. Work tabs carry their
  project context, can be opened/closed with explicit X controls, and do not
  depend on a left-rail icon.
- Task workspaces keep the agent terminal on the left and open task panes on the
  right. The pane strip includes Agent, Browser, Editor, Artifacts, Git,
  Settings, Processes, and Excalidraw.
- Terminal sessions are retained per tab instead of recreated on every switch.
  Each native terminal view has its own `TerminalSession` instance and stable
  SwiftUI identity.
- The terminal renderer now prefers Nerd Font / Powerline-capable fonts before
  falling back to Menlo so zsh/power10k glyphs can render when installed.
- The editor panel now uses an expandable tree, syntax-highlighted code view,
  theme picker, Markdown preview/edit modes, and image preview.
- The command palette is keyboard navigable with up/down/return/escape even
  while the search field has focus.
- First-run browser auth has a native callback path through `matrixos://auth`.

The native branch is still a large 086 feature branch. The backend auth/session
piece is split into a smaller first PR so it can merge and deploy before the
native shell PR depends on it.

## Stack

1. `087-native-auth-callback` / PR #372
   - Platform device auth accepts `matrixos://auth` callbacks for the native
     macOS client.
   - Gateway shell session names accept generated zellij names with underscores.
   - This sits on latest `origin/main`, including PR #371's zellij PTY startup
     fix.
2. `086-macos-native-shell`
   - Native macOS UI and terminal/editor/task workspace changes.
   - Depends on #372 for login handoff and generated session names.
3. Follow-up launch PRs
   - Platform billing/runtime onboarding for computer power and region.
   - Deeper gateway file/editor/git APIs where the native shell needs stronger
     contracts.

## Reference Findings

### SlayZone

Use SlayZone's left-bar hierarchy and tab language:

- Project identity is always visible in the left bar.
- Work tabs are compact, readable, and include status/context.
- Settings are a real right-side inspector, not placeholder controls.
- Tool tabs should stay workspace-level, not per-task `Terminal/Shell/App`.

### RepoPrompt CE

Use RepoPrompt-style native macOS patterns:

- Native split panes and persistent project/workspace state.
- File tree/context selection is a first-class surface.
- Tooling should feel like a local Mac app even when data comes from remote
  Matrix.

### CodexBar

CodexBar is a useful native-account/settings reference:

- Data-driven settings and account rows.
- Privacy-first auth/token source handling.
- Small, polished status surfaces and menu-like controls.

### SwiftDANSI

SwiftDANSI is useful for future terminal/agent markdown rendering:

- Strip ANSI for measurement before wrapping.
- Preserve ANSI styling intentionally instead of ad hoc string slicing.
- Good candidate for rendering agent markdown/status summaries into terminal
  output or sidebar previews.

### Ghostty

Ghostty is the right long-term terminal renderer reference:

- Treat a terminal "surface" as the unit for a window/tab/split/preview.
- Own resize/focus/search per surface.
- Coalesce SwiftUI/AppKit size changes and avoid stale terminal dimensions.
- Long-term option: evaluate `libghostty-vt`/Ghostty surface integration before
  replacing SwiftTerm.

### Warp

Warp is useful as an interaction model, not as a dependency:

- Tabs/summaries should expose title, working directory, branches, and status.
- Command/search is central and always discoverable.
- Terminal model locking warning maps to Matrix: do not let tab switching
  acquire nested terminal/session state or recreate terminals unnecessarily.

## Launch Architecture

### Workspace Tabs

Tabs are the unit of work:

- `Home`: default first tab, shows Matrix OS shell at `app.matrix-os.com` or the
  selected runtime shell.
- `Terminal`: attaches to a zellij/Matrix session.
- `Task`: task-linked session tab with project marker.
- `App`: first-party Matrix app such as Excalidraw/Whiteboard, Files, Editor.

Terminal tabs must keep `TerminalSession` instances alive while switching. The
native app should not tear down a terminal just because the user clicks another
tab. Close explicitly shuts down/detaches the session view.

### Auth and Onboarding

Native launch flow:

1. User opens app.
2. If no principal token/profile exists, show onboarding.
3. Signup/signin opens Clerk in the default browser.
4. Browser completes Clerk/platform auth.
5. Native app receives completion through a custom URL callback or polls the
   device-auth flow until approved.
6. User chooses computer power and region.
7. Checkout/provisioning happens through platform routes.
8. Native app picks up the selected runtime and opens `Home`.

The app must not assume that opening an external browser login means the native
principal exists. It needs a callback or device-code polling loop that writes the
principal to Keychain and refreshes the profile.

### Sidebar and Top Bar

Sidebar requirements:

- Collapsible/expandable.
- Larger Matrix logo top-left.
- SlayZone-style project list/switcher with active project row.
- Board/Terminals/Files/Git/Settings as recognizable icon+label rows when
  expanded, icons-only when collapsed.
- User card at bottom with avatar/initials, handle/email when available, and a
  working account/settings action.

Top bar requirements:

- Center command/search control with `⌘K`.
- Back/forward and active tab controls.
- Project color accent can tint app/tool tabs.
- "Close Terminal" replaces "Detach".

### File Manager and Editor

Native file manager should use existing gateway endpoints:

- `/api/files/tree?path=...` for expandable tree loading.
- `/api/files/list?path=...` only as fallback.
- `/files/{path}` for read/write.
- `/api/files/stat`, `/api/files/search` for preview/search.

The native view should be an expandable tree, not folder navigation. Code editor
should start as a polished native code viewer/editor with themes and file tabs.
Longer-term options:

- Embed Monaco or CodeMirror in a local WKWebView editor app.
- Evaluate a native TextKit-based editor for Swift-only polish.
- Reuse Matrix web file-browser/editor components where embedding is safer than
  rebuilding.

### Terminal Stability

Immediate:

- Maintain `TerminalSession` per open terminal tab.
- Switching tabs focuses an existing session instead of recreating sockets.
- Keep output coalescing and bounded scrollback.
- Add active/connecting/reconnecting/exited status per tab.
- Ensure resize is sent only when dimensions actually change.

Long-term:

- Evaluate Ghostty/libghostty-vt for terminal emulation/rendering.
- Keep SwiftTerm until Ghostty integration is proven by spike tests.
- Warp block-style command output is a UX inspiration, not a renderer swap.

## Implementation Tasks

### P0: Implemented In This Stack

- [x] Add `WorkspaceTab` support for `Home`, terminal/session, task, and app
  panes.
- [x] Make `Home` a first-class tab and show the Matrix shell when a runtime is
  connected.
- [x] Keep terminal sessions alive across tab switching.
- [x] Replace `Detach` language with explicit close-tab/close-terminal actions.
- [x] Redesign sidebar as collapsible/expandable with larger Matrix identity,
  project list, live session list, user card, and full hit targets.
- [x] Move command palette into a centered top-bar control with `⌘K` and
  keyboard navigation.
- [x] Add native Clerk/browser auth callback support through PR #372.
- [x] Replace flat file navigation with an expandable tree viewer.
- [x] Add image preview plus Markdown preview/edit and code edit themes.
- [x] Add pane buttons for Browser, Editor, Git, Settings, and other SlayZone
  surfaces inside every task workspace.

### P0: Still Required Before Launch

- [ ] Deploy PR #372 to the platform/app-shell surface so browser login can
  redirect back to the native app.
- [ ] Verify live zellij switching against a VPS running PR #371 and #372.
- [ ] Persist workspace tabs across relaunch.
- [ ] Make the Settings pane a full project/task/runtime/account form, not just
  a summary surface.
- [ ] Confirm Excalidraw/Whiteboard route availability through the production
  `whiteboard`/Excalidraw shell path.
- [ ] Add onboarding cards for signup, runtime selection, checkout/provisioning,
  and desktop handoff.

### P1: Launch Polish

- [ ] Project accent coloring for app/tool tabs.
- [ ] Better selected terminal header: project, cwd/session, branch/status.
- [x] Status badges for live/connecting/reconnecting/exited.
- [ ] Empty states for Home, Files, Editor, Settings.
- [x] Theme-consistent code editor with monospace line layout.
- [ ] Runtime checkout/provisioning flow for computer power and region.
- [ ] New-project GitHub Projects and Linear setup flows after provider linking.

### P2: World-Class Cloud Dev IDE

- [ ] Persistent task plans, subtasks, artifacts, and pane layout per task.
- [ ] Git branch/commit/pull/push/create-PR flows with audited gateway
  mutations and typed errors.
- [ ] Browser preview tabs with auth-aware external-login handoff.
- [ ] File manager bulk actions, search, rename/move/delete, and drag/drop.
- [ ] Code editor diagnostics, find/replace, minimap, and multi-file tabs.
- [ ] Vertical terminal splits with focus/resize/search per surface.
- [ ] Session recovery: reconnect tabs to live zellij sessions after app crash.
- [ ] RepoPrompt-style context builder for selecting files/skills/plugins.
- [ ] Runtime/billing/account settings that work before and after VPS
  provisioning.
- [ ] Public docs update under `www/content/docs/` after the stack lands.

### P3: Deeper Follow-Up

- [ ] Ghostty/libghostty-vt spike.
- [ ] Monaco/CodeMirror WKWebView editor spike.
- [ ] SwiftDANSI-based markdown/ANSI preview rendering.
- [ ] RepoPrompt-style skills/plugins manager.
- [ ] Runtime/billing/platform deployment validation on app.matrix-os.com.

## Verification

- `swift test --package-path macos`
- Build/launch via `./script/build_and_run.sh --verify`
- Visual screenshots after every major UI slice.
- Manual flows:
  - first-run signup
  - returning user
  - runtime selection
  - Home shell loads
  - open terminal, switch away, switch back
  - open task from board
  - open Files tree and edit a file
  - open Settings account/runtime

## Sources

- SlayZone: `/Users/hamed/dev/claude-tools/slayzone`
- RepoPrompt CE: `/Users/hamed/dev/claude-tools/repoprompt-ce`
- CodexBar: `https://github.com/steipete/CodexBar`
- SwiftDANSI: `https://github.com/steipete/Swiftdansi`
- Ghostty: `https://github.com/ghostty-org/ghostty`
- Warp: `https://github.com/warpdotdev/warp`
