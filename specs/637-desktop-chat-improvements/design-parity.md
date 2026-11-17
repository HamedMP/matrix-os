# Figma parity correction · ENG-461

The November 16 side-by-side audit supersedes the previous visual-readiness assessment. The existing PRs stay out of draft at the requester’s instruction; final review readiness still requires fresh equivalent-state Web and Electron captures against Figma section 2343:13253, trusted Greptile 5/5 and green CI. No Slack messages are authorized.

## Correction sequence

1. Reuse shared primitives for the full Archived page, header search, date groups, hover Restore/Delete, selection toolbar, Esc clear, confirmation and restore Undo. Link it from Search and the six-second archive toast.
2. Match side-chat bubbles, persistent context notice, Send to main/Copy icon actions, compact composer and tab styling.
3. Share inspector tabs and New tab picker; preserve native Browser access. Add the matching Web tab model. Match file tree/preview, split grip, terminal tab actions, resize grip/width label, and scoped persistence.
4. Align sidebar hierarchy, status/project sub-lines, project bulk-archive menu and chat row menus. Preserve existing source filtering, shared/Drive access and owner boundaries.
5. Run regressions, typecheck, patterns, React Doctor and builds; run exact PR heads locally as authorized by the requester; capture equivalent states at 1512×982, narrow widths and both themes. Compare every state in Figma 7.1–9.6, attach evidence to each UI PR, then obtain current-head review and CI.

## Refactoring boundaries

WorkTab already exceeds the entrypoint size guideline. Extract responsive layout/resize primitives before adding archive navigation. Archive state and its page outlet live in WorkSurfaceRuntime. Extract the inspector tab strip and picker to packages/ui rather than extending the large WorkFilesInspector with a second tab implementation. Web consumes these same implementations.

The existing WorkTab integration harness also exceeds 1,000 lines. Its follow-up extraction should move shared client/ResizeObserver fixtures into one test helper and move hosted-window chrome cases into a focused suite, retaining the real WorkTab-to-SurfaceChrome boundary. The narrow toolbar regression extends the existing hosted-window case so it does not duplicate those fixtures.

## Behavior checks

- Visiting Archives hides the retained conversation and inspector instead of unmounting them, so an unsent Side chat question survives returning to the same chat. Authority changes still reset the archive provider.
- Main/side transcripts remain server-separated; Copy cannot submit a main-chat turn.
- Archive actions retain revision checks, failed selections, server search/cursors and authority generation guards.
- Terminal close remains confirmed and stops only its own session; closing other tabs leaves sessions intact.
- Restored rows return in both project and status placements; per-group pages and counts stay stable.
- New captures replace stale qualification claims. Missing runtime access remains a blocker, not visual approval.

### Remaining full-CI consumer regressions

The six failing native suites reproduce ten failures locally. Keep the existing assertions for unread mutations without opening a chat, import filtering, preview-read cancellation, destructive-menu separation and accessible status text. Update the UI entry points and semantic menu-label queries for the approved Figma layout. The status audit stays unchanged; production status/error labels use danger-text instead of fill tokens. Co-locate the small paging, persisted inspector layout, Side draft context, filter menu and archive destination helpers with their existing owning modules so this layer remains within 50 files without dropping tests or adding a PR. The first prepared three suites retain their 14 passing checks.

### Web full-CI consumer reconciliation

Seven Web suites fail red against the old input, width, preview-close and reorder signatures. Use the 240px desktop rail, actual filter popover and Search combobox, visible file-preview host control, and bounded visible-ID reorder argument. Preserve phone inline source+search coverage and add the desktop filter/global-dialog path. Small related helpers are co-located with existing paging, ordering, history, project-navigation and client modules to retain the 50-file limit.

### Full-CI unit shard reconciliation

The Linux shard exposed three stale consumer tests: the agent chrome fixture replaced the archive hook, the token audit omitted shared UI CSS, and Done expected its Figma live count to disappear while expanded. Preserve the real archive exports, include shared CSS definitions in the existing token audit, and retain the live-count assertion through collapse/expand. CI supplies red evidence for all four assertions. Archive, Side chat, and paged-rail regression suites are retained unchanged in the final integration layer to keep the native layer at 50 files; none of their assertions are deleted. Runtime source is unchanged by this reconciliation.
## Retained archive protection

The bespoke Web archive dialog and its three tests are replaced by the shared full-page archive implementation. The shared archive suite retains title/message search with cursor paging, restore and confirmed deletion, late-page rejection, failures/retry and Undo coverage. Web navigation tests additionally exercise Search → Archived → full page and restoring an older chat back into an already-expanded project. Project filter chips were an implementation addition absent from the Figma; the archive page keeps project context and searches all projects.


### Canonical file-scope review correction

Extract active/latest run-root selection into the pure shared `canonicalChatFileScope` contract helper, with missing-run and mismatched-project roots failing closed. Keep useCanonicalChatState as a projection call and pass its result through Web Desktop, Web Canvas and Web Mobile adapters. Inspector consumers retain worktree IDs for browsing and previews. The follow-up composition extraction for the existing large ChatApp/useCanonicalChatState entrypoints remains scoped to their routing and rendering responsibilities; this fix adds no duplicate run-root business rules there. Native scope adapts the same shared selector while preserving its verified project slug lookup.

### Paged read and restored search correction

Successful read mutations publish a versioned, owner/runtime-scoped cache of at most 500 recently updated chat records. Project and status placements merge that read projection without resetting rows, cursor positions, counts, or transcript metadata; unread-only project rows filter the merged state. Older records are not inserted into the initial global navigation window. Restored search tombstones affect Archived only; permanent deletions affect every lifecycle, including subsequent pages. Focused production-boundary regressions exercise the state producer, retained page consumer, and restoration across active search scopes. Broad unit qualification completes in exact-head CI under the requester’s recorded exception; focused tests, typecheck, patterns and React review still run locally.

### Local design correction qualification

The requester approved local Web and native Electron qualification in place of a deployed preview, and explicitly prohibited Slack posts. The final inspector layer covers the Web Files/Terminal/Side chat implementation plus the native pane alignment correction: reserve the Chat toolbar only over the conversation and keep its actions before the inspector, leaving the inspector tab row unobstructed. Short native conversations use the shared bottom-aligned transcript layout. Inspector transport, lifecycle/layout state, and rendering are separate focused modules.

Local evidence uses an isolated Postgres database and Matrix home, an isolated encrypted Electron QA profile, and the real local Zellij adapter without the Linux systemd lifecycle. The transcript is committed through the production canonical orchestrator using a synthetic adapter; side-chat replies are seeded, and no production provider or customer data is used. Web uses the existing local E2E authentication/billing bypass. Provider availability, computer inventory, and organization Drives are not qualified by these fixtures. Broad local suite execution remains limited by legacy Node ABI and Linux host fixtures; focused tests and exact-build captures do not replace Linux CI.

### Final live-review corrections

The local Web run exposed a producer/consumer mismatch: chats retain canonical project IDs, while the existing file-preview and terminal APIs resolve verified project slugs. The Web inspector now follows the native adapter at that boundary. A regression creates an actual temporary project and routes a rendered chat file click through the production Gateway preview service.

Both desktops use the compact project-root label with an on-demand file filter and shared full-path file links. Web short transcripts align above the composer; desktop starter suggestions stay in the empty state. Web Search cancels the base dialog's individual translate offset before applying its explicit main-pane position. Archive navigation exits for every accepted destination. Manual rail order applies to independently loaded status and project placements, including chats absent from the initial summaries. Terminal discovery rejects pre-mutation responses, creation evicts mounted views without stopping sessions, and hidden Chat cannot handle inspector shortcuts.

The follow-up qualification keeps unsent side questions mounted across tab switches on both desktops and uses the existing Web code editor in read-only mode for numbered file previews. Opened files reveal their parent folders and selection; large directory views retain 1,000 rows at a time and filter before windowing, with Previous/Next access through the existing directory endpoint. Project-resource conversion is shared by desktop and mobile preview paths. Search centers over the conversation when the inspector is open, and shared controls explicitly consume the desktop color tokens in dark mode. Manual reordering preserves saved positions outside the moved subset, respects the displayed page order, and rejects stale targets.

Final review regressions additionally preserve explicit selection when the startup chat is reselected, snapshot the displayed server group's order before its first manual move, and reveal each ancestor's correct directory window. The file filter uses the existing bounded Gateway search within the verified file root, including unopened folders; it retains at most 200 matches and asks for a narrower filter when truncated. Phone headers omit desktop inspector controls while retaining their existing file-preview fallback. The New tab picker includes the current file and saved Side chat alongside terminals.

The final narrow Electron capture found that an exclusive Files inspector could cover the floating window's still-active title/share controls. Hosted narrow inspectors now begin below the shared OS window gesture height; docked inspectors retain the Figma-aligned tab row. The production WorkTab integration regression fails without that offset and checks that closing the inspector still returns to Chat.
