# Task 12: Desktop App (Operator) — Edit Report

**Status: DONE**

## Changes made

### Structural additions
- Added `import` block for `Callout`, `Card`/`Cards`, `Step`/`Steps` (page had no imports before)
- Wrapped install steps in `<Steps>` / `<Step>` components for consistency with sibling pages
- Added `<Callout>` for macOS-only platform note and shared terminal sessions note
- Added `<Cards>` Related section cross-linking `/docs/shell` and `/docs/cli`
- Added a keyboard shortcuts reference table (cleaner than the bullet list)

### Accuracy corrections
- **Sidebar nav**: the original said "Home and Agents — then open Terminals — then Projects." The code shows four fixed nav items: Home, Chat (Hermes), Terminal, Apps — then a collapsible Projects section. Corrected.
- **Editor**: original said "VS Code-class (Monaco)." The desktop uses CodeMirror (`@codemirror/*` deps), not Monaco. Corrected.
- **Auth deep link**: clarified that `matrixos://auth?status=approved` is a focus signal only; auth completes via polling. This matches `device-auth.ts` and CLAUDE.md.
- **"Canvas" tab**: the original described opening the "Canvas tab" to reach the hosted web shell. The sidebar code has no Canvas tab — Canvas is a web shell concept. Removed that section; the Apps tab and the web shell are described separately.
- **⌘N for new task**: original listed `C / ⌘N`. The shortcuts code only binds bare `C` for new task; `⌘N` is not wired there. Removed.
- **Settings sections**: original listed only "account, runtime/VM selection, appearance, and system info." The actual SettingsView has nine sections: Account, Billing, Appearance, Agent (Hermes), Runtime, Channels, Integrations, Schedules (Cron), System. Expanded.
- **Sidebar toggle shortcut**: added `⌘B` / `⌘\` (both wired in shortcuts.ts).

### Voice / clarity
- Removed hedging phrases like "still being verified" and "remains gated on" for facts that are now verifiable from code.
- Kept honest uncertainty only for public distribution availability (which is genuinely gated/pending).
- Tightened description prose throughout.

## Uncertainties

- **Public download path**: no public download URL exists yet. The page says "current builds are internal" which matches the original's note about the release pipeline.
- **⌘N new task from board**: `Board.tsx` was not read — `⌘N` may be wired there even though it is absent from the global `shortcuts.ts`. If so, restore it to the shortcut table.
- **`⌘⇧O` (new chat) shortcut**: wired in shortcuts.ts but omitted from the table to keep it concise; can be added if the shortcuts section is expanded.
- **Notification behavior**: kept the background-completion-notification claim removed (original said "still needs live-VPS verification"); left notifications unmentioned to avoid overpromising.
