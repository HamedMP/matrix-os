# Chat diagrams and file previews

Ticket: [ENG-393](https://linear.app/matrix-os/issue/ENG-393/improve-chat-diagrams-and-file-previews-in-electron-desktop)

## Outcome and order

1. Electron Desktop: render fenced Mermaid diagrams in Chat and Markdown previews; preserve source/copy and readable failures.
2. Electron Desktop: render sidebar Markdown, show code colors, preview unsaved Markdown alongside its source, provide PDF page/zoom controls, editable previews, actual file/folder context actions, filename search, and a collapsible file tree.
3. Electron Desktop: add a sidebar Browser tab using the existing isolated local WebContentsView. Public websites load on the user's computer; runtime loopback addresses retain the existing authenticated remote tunnel routing. Remote HTML files use the authenticated file preview and its network/script-disabled sandbox.
4. Native Mobile and Web Mobile: bring the diagram capability to Chat after the desktop increment is verified. Reuse the pinned Mermaid distribution offline, isolate its document, and keep unclosed streaming fences readable as source.

Product/design owner review of browser placement, file actions, and PDF controls is recommended. Hamed authorized implementation and a short ENG ticket in this chat.

## Sources of truth and security

- File resource descriptors and the captured runtime/auth generation remain authoritative. File reads and downloads use existing authenticated routes. No new application persistence is introduced. Archive directory enumeration extends the existing authenticated file-preview router and resource authorization.
- Markdown uses GFM, safe URL transformation and escaped raw HTML. Mermaid uses strict security, disabled HTML labels, locked security configuration, 30,000 characters and 500 edges. SVG is displayed as an inert image, with object URLs revoked on change/unmount. Incomplete/invalid diagrams fall back to source with generic errors.
- PDF receives already bounded authenticated bytes, runs parsing in a bundled worker, disables evaluation/Wasm, bounds images/canvas dimensions, and destroys tasks on unmount. It displays one page at a time with page and zoom controls; text selection/search and PDF forms are later improvements.
- The editor previews its unsaved in-memory buffer. View changes do not save, replace the model, or discard dirty edits. Existing optimistic file conflict handling remains in force.
- The Browser uses the existing embed navigation admission, sandbox, isolated browser partition, popup/download restrictions and runtime URL classifier. The add-tab menu holds a renderer overlay lease so the native view detaches while the menu is open. It detaches while hidden and never receives the renderer's preload API.
- File and folder tree rows offer Copy path, Open in Files and Download. Files keeps project/worktree resources scoped through existing project APIs; worktree-relative paths are never reinterpreted as home paths. Archives use a dedicated complete directory listing that includes dotfiles for home/project/worktree resources, rejects symlinks and unsupported entries, and fails on truncation or enumeration errors; they never reuse the tree display list. Folder downloads create a bounded ZIP (1,000 entries, 50 MiB total, 32 levels, 60 seconds) and reject escaping, duplicate and unsupported entries.
- Markdown/code previews fill the available pane from the top; media alone remains centered. Hide/show tree and closing/reopening the inspector preserve expanded folders, filter, scroll position, selected file, visibility and width across remounts/reloads. Local navigation preferences are validated and capped at 32 recent views/1 MiB, scoped to account, platform, computer, chat and project/worktree; file contents/listings are never persisted. Explicit Open in Files requests carry a fresh reveal key so a new navigation opens its requested folder even in a previously saved tree. Ordinary close/reopen restoration preserves deliberately collapsed folders. Filename search combines loaded entries with existing authenticated home/project search, debounces requests and caps visible results at 100.
- Preview Edit opens the existing Editor with explicit Save and Markdown Source/Split/Preview controls. Home editing keeps the existing 2 MiB limit; worktree editing uses the existing 64 KiB content API and atomic etag-checked saves. Unsaved buffers remain visible on conflicts.
- Hamed confirmed on 25 October 2026 that static HTML preview is sufficient for this scope. Preview static, self-contained remote files with scripts and network access disabled. Interactive scripts and adjacent external assets are outside this increment and are not a completion blocker. Public website URLs still use the separate local Browser view.

## Existing routes and auth

| Route / IPC | Purpose | Auth source |
| --- | --- | --- |
| `/api/file-previews/directory` | Complete, unfiltered archive directory listing, max 1,000 entries, 10-second enumeration bound | Existing owner/path/project/worktree authorization and runtime generation; no public access; unsupported/oversized/changed directories fail closed |
| `/api/files/preview` and content routes | Descriptor and bounded home/project/worktree reads | Existing owner/project authorization, pinned runtime generation |
| Existing project browse/search/content/save IPC | Worktree-scoped Files navigation, search and editing | Existing native sender/runtime auth, project/worktree authorization and etag write guard |
| Existing file-download IPC | Save home files to local disk | Current native runtime/auth generation |
| Existing `embed:*` browser IPC | Local website view or admitted runtime tunnel | Validated native IPC sender and existing embed policy |

## Verification and delivery

- Tests first: Mermaid fences/source/copy, invalid and excessive input, stale completions and URL cleanup; sidebar Markdown/actions; unsaved editor preview; PDF controls/worker cleanup; browser URL admission and hidden-view lifecycle.
- Run desktop typecheck/build, focused regressions, pattern check and React Doctor. Test actual Mermaid output in the in-app browser and the running Electron dev app. Local fixture results are development checks, not deployed review qualification.
- Create a separate documentation PR in `FinnaAI/matrix-os-site` covering Mermaid fences, Markdown Source/Split/Preview, file actions, PDF limits and local versus remote browsing.
- Before review/merge readiness: attach screenshots and short recordings from the exact deployed PR build for every affected surface, compare equivalent states, share evidence in Slack #tech and link its permalink in the PR. The desktop-first increment does not yet qualify Native Mobile/Web Mobile.
- Web Canvas/Web Desktop use separate presentation code and already render Chat Mermaid through Streamdown. Shared file-preview extension points preserve their existing behavior until their feature parity implementation/evidence is included; this is an explicit remaining parity task, not an N/A claim.

## Current development checks

- Latest fetched base: `be6cce1404` on 25 October 2026.
- Separate manual worktree: `codex/chat-diagrams-file-preview`. Main's existing edits are preserved; its fast-forward was blocked by overlapping edits.
- The initial increment passed 76 focused desktop/shared UI tests, desktop typecheck/build and React Doctor. Feedback regressions cover actual file/folder row actions, archive limits/cancellation, tree visibility/search, project-scoped editing/saving and stale edit cancellation. Current validation is recorded in the PR. The inspector composition remains one responsibility at roughly 550 lines; future parity work should extract its terminal lifecycle and toolbar rather than grow this container.
- Local browser checks verified the first Markdown heading is below the preview header, code starts at the pane top and fills its height, hiding the tree widens the preview, and file filtering/context menus appear on real inspector rows. These synthetic development fixtures were removed after checking; they do not qualify as deployed evidence.
- Native Mobile: completed Mermaid fences now use an offline, isolated WebView; incomplete streaming fences remain readable source. Source/copy/failure controls, render timeouts, a ten-diagram cap per message, scrolling for tall diagrams, and bounded bridge messages are covered by 30 passing mobile diagram/Markdown/Chat tests. Shared renderer security configuration lives in `@matrix-os/ui/chat-diagram-policy`. Its offline HTML document was also checked in the in-app browser; this is not Native Mobile evidence.
- Full mobile typecheck remains blocked by React type resolution in existing `react-native-svg`, `expo-image`, gesture and drawer components. The new diagram files have no remaining diagnostics after adding the missing WebView-to-React-types dependency edge. Those other package issues are outside this increment.
- Regenerate the pinned mobile library with `pnpm --dir apps/mobile exec node scripts/bundle-mermaid.mjs`. No new native dependency or CDN is required. There is no booted iOS simulator; Native Mobile runtime evidence remains outstanding. No deployed evidence or release is claimed.

The offline Mermaid regeneration command is a development tool invoked directly with Node; it does not change mobile package scripts or the native OTA fingerprint.
