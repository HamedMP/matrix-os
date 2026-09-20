# Human Review

1. Open Chat project navigation in Electron Desktop, both standalone and hosted window presentations. Web Desktop/Web Canvas/Web Mobile currently have no project-group navigation; see the spec limitation.
2. Hover/focus a long project row: ellipsis precedes New Chat, no trash button, name does not overlap controls.
3. Compare ellipsis/right-click menus; use keyboard and Escape; verify focus returns.
4. Pin, reload, unpin. Verify stable ordering and existing pinned Chats unchanged.
5. Edit name/description; verify reload and other project projections. Invalid/failed save retains draft.
6. Open in Files: correct project root, nested browsing and file preview. No local Finder invocation for remote runtime paths.
7. Delete action requires existing typed confirmation. Cancel preserves project.
8. Switch runtime while mutation/dialog is pending: no stale state or old project dialog survives.

## Automated validation — 2026-09-20

- Gateway metadata/lifecycle: 23 tests passed; metadata cases were red before implementation.
- Workspace routes, board store, WorkRail, hosted sidebar and initial action tests: 107 passed.
- Expanded final UI suites: 61 passed (12 action tests, 44 WorkRail tests, 5 hosted sidebar tests), including stale runtime/catalog results and duplicate submission.
- Desktop and Gateway scoped TypeScript checks passed.
- Browser component fixture: observed menu, icon/separator layout, Edit inputs, pin indicator and focus return after Cancel. This is not authenticated Electron/VPS Human Review.
- Site documentation tests: 100 passed. Rendered docs checks were blocked by an existing undeclared `next-themes` import in `src/components/mdx/mermaid.tsx`; no dependency changes were made for this documentation-only PR.
- Pending: authenticated runtime end-to-end and Human Review, CI and Greptile. No deployment or merge performed.
