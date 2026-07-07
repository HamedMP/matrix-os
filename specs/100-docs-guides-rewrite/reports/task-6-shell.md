# Task 6 — Web Shell page report

## Status: DONE

## Structure

1. **Intro paragraph** — positions `app.matrix-os.com` as the primary interface.
2. **Terminal and sessions** (Steps) — open Terminal, create/attach named sessions, detach with `Ctrl-\ Ctrl-\`. Grounded in `TerminalApp.tsx` (`/api/terminal/sessions` endpoint confirmed at lines 1111, 1139, 1159, 1183).
3. **GitHub auth** — `gh auth login` inside a terminal session. Includes the mandatory SSH-passphrase Callout (type="warn"). Confirmed present.
4. **File browser** — FileBrowser component confirmed at `shell/src/components/file-browser/`. Desktop.tsx opens it as `__file-browser__` under the label "Files". Capabilities (column view, list view, Quick Look, preview panel, context menu, trash) confirmed from component files (`FileBrowserContent.tsx`, `ColumnView.tsx`, `ListView.tsx`, `QuickLook.tsx`, `TrashView.tsx`, `FileContextMenu.tsx`, `PreviewPanel.tsx`).
5. **What persists** — matches existing content and CLAUDE.md.
6. **Related Cards** — links to `/docs/cli` and `/docs/coding-agents`.

## Uncertainties / gaps

- **Exact sidebar label for Terminal** — CLAUDE.md says "Canvas, Terminal, Files" are in the sidebar; Desktop.tsx confirms `addApp("Terminal", "__terminal__", ...)` and `addApp("Files", "__file-browser__", ...)`. Phrased as "sidebar or dock" to cover both Canvas and Desktop modes.
- **"New tab" / "+" button label for creating sessions in the browser UI** — TerminalApp.tsx confirms session tabs exist and creation calls `POST /api/terminal/sessions`, but the exact toolbar button label is not extractable without running the UI. Documented the CLI path (`matrix shell new`/`matrix shell connect`) which is confirmed in code and cli.mdx.
- **File browser view mode names** — `ColumnView.tsx`, `ListView.tsx`, `IconView.tsx` exist as components; toolbar buttons that toggle them were not read in full. Used "column view or list view" as safe labels.
- **`/docs/coding-agents`** page existence — cross-linked per task instructions; not verified as an existing route. If the page does not exist yet, the Card link will 404 until it is created.

## SSH-passphrase Callout

Present in the page exactly as specified in the task instructions (type="warn").
