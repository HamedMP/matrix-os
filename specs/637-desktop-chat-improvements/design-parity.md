# Figma parity correction · ENG-461

The November 16 side-by-side audit supersedes the previous visual-readiness assessment. UI PRs #3320 and #3321 remain drafts until new equivalent-state Web and Electron screenshots and recordings match the original Figma section 2343:13253. No Slack messages are authorized.

## Correction sequence

1. Reuse shared primitives for the full Archived page, header search, date groups, hover Restore/Delete, selection toolbar, Esc clear, confirmation and restore Undo. Link it from Search and the six-second archive toast.
2. Match side-chat bubbles, persistent context notice, Send to main/Copy icon actions, compact composer and tab styling.
3. Share inspector tabs and New tab picker; preserve native Browser access. Add the matching Web tab model. Match file tree/preview, split grip, terminal tab actions, resize grip/width label, and scoped persistence.
4. Align sidebar hierarchy, status/project sub-lines, project bulk-archive menu and chat row menus. Preserve existing source filtering, shared/Drive access and owner boundaries.
5. Run regressions, typecheck, patterns, React Doctor and builds; run exact PR heads locally as authorized by the requester; capture equivalent states at 1512×982, narrow widths and both themes. Compare every state in Figma 7.1–9.6, attach evidence to each UI PR, then obtain current-head review and CI.

## Refactoring boundaries

WorkTab already exceeds the entrypoint size guideline. Extract responsive layout/resize primitives before adding archive navigation. Archive state and its page outlet live in WorkSurfaceRuntime. Extract the inspector tab strip and picker to packages/ui rather than extending the large WorkFilesInspector with a second tab implementation. Web consumes these same implementations.

## Behavior checks

- Main/side transcripts remain server-separated; Copy cannot submit a main-chat turn.
- Archive actions retain revision checks, failed selections, server search/cursors and authority generation guards.
- Terminal close remains confirmed and stops only its own session; closing other tabs leaves sessions intact.
- Restored rows return in both project and status placements; per-group pages and counts stay stable.
- New captures replace stale qualification claims. Missing runtime access remains a blocker, not visual approval.

### Full-CI unit shard reconciliation

The Linux shard exposed three stale consumer tests: the agent chrome fixture replaced the archive hook, the token audit omitted shared UI CSS, and Done expected its Figma live count to disappear while expanded. Preserve the real archive exports, include shared CSS definitions in the existing token audit, and retain the live-count assertion through collapse/expand. CI supplies red evidence for all four assertions. Archive, Side chat, and paged-rail regression suites are retained unchanged in the final integration layer to keep the native layer at 50 files; none of their assertions are deleted. Runtime source is unchanged by this reconciliation.
