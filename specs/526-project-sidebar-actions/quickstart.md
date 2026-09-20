# Human Review

1. Open Chat project navigation in Electron Desktop, Web Desktop and Web Canvas.
2. Hover/focus a long project row: ellipsis precedes New Chat, no trash button, name does not overlap controls.
3. Compare ellipsis/right-click menus; use keyboard and Escape; verify focus returns.
4. Pin, reload, unpin. Verify stable ordering and existing pinned Chats unchanged.
5. Edit name/description; verify reload and other project projections. Invalid/failed save retains draft.
6. Open in Files: correct project root, nested browsing and file preview. No local Finder invocation for remote runtime paths.
7. Delete action requires existing typed confirmation. Cancel preserves project.
8. Switch runtime while mutation/dialog is pending: no stale state or old project dialog survives.
