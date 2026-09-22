# Human Review

1. Open Chat project navigation in Electron Desktop, both standalone and hosted window presentations. Web Desktop/Web Canvas/Web Mobile currently have no project-group navigation; see the spec limitation.
2. Hover/focus a long project row: ellipsis precedes New Chat, no trash button, name does not overlap controls.
3. Compare ellipsis/right-click menus; use keyboard and Escape; verify focus returns.
4. Pin, reload, unpin. Verify the project moves between Projects and Pinned, the project row has no standalone pin glyph, ordering is stable, and existing pinned Chats remain unchanged.
5. Edit name/description; verify reload and other project projections. Invalid/failed save retains draft.
6. Show in Files: opens the full Files app at the actual project folder. Verify managed and imported folders, existing Files window reuse, repeated clicks and missing-folder errors. No project file modal or Finder invocation.
7. Delete action requires existing typed confirmation. Cancel preserves project.
8. Switch runtime while mutation/dialog is pending: no stale state or old project dialog survives.

## Automated validation — 2026-09-20

- Gateway metadata/lifecycle: 23 tests passed; metadata cases were red before implementation.
- Workspace routes, board store, WorkRail, hosted sidebar and initial action tests: 107 passed.
- Expanded final UI suites: 61 passed (12 action tests, 44 WorkRail tests, 5 hosted sidebar tests), including stale runtime/catalog results and duplicate submission.
- Desktop and Gateway scoped TypeScript checks passed.
- Browser component fixture: observed menu, icon/separator layout, Edit inputs, Pinned section placement without a project-row pin glyph, and focus return after Cancel. This is not authenticated Electron/VPS Human Review.
- Site documentation tests: 100 passed. Rendered docs checks were blocked by an existing undeclared `next-themes` import in `src/components/mdx/mermaid.tsx`; no dependency changes were made for this documentation-only PR.
- Pending: authenticated runtime end-to-end and Human Review, CI and Greptile. No deployment or merge performed.

## Requirement correction — 2026-09-21
PR #1772 is closed. Previous component-fixture/test evidence is historical and does not validate the corrected Files navigation. Implementation is paused; no new navigation implementation has been published.

## Resumed implementation — 2026-09-21
- Full Files navigation implemented with owner-scoped location resolution and a bounded runtime-scoped navigation intent.
- Desktop/Gateway TypeScript and Electron production build passed.
- Targeted regression suites cover canonical/imported paths, invalid/missing folders, same-folder reuse, metadata persistence, stale runtime responses and existing WorkRail behavior.
- Preview VPS and authenticated Electron Desktop validation in progress.
