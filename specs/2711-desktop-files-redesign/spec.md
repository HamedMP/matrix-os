# 2711: Electron Desktop Files redesign

- Ticket: [ENG-573](https://linear.app/matrix-os/issue/ENG-573/redesign-the-electron-desktop-files-app-on-the-matrix-design-system)
- Design: nine approved mockups (Home grid, List multi-select, Details panel, Context menu and rename, Search, New menu and uploads, Trash, Organization drive, States and dialogs), kept outside the repo with the brief.
- Source of truth for tokens and components: `FinnaAI/matrix-os-design-library` (`styles/tokens.css`, `components/ui/*`).
- Stakeholder review suggested: product (Nima), design owner of the design library.

## Goal

Rebuild the Electron Desktop Files app so it matches the approved redesign and uses Matrix design-library tokens and components, without changing what Files can do in the first phases.

## Affected surfaces

| Surface | In scope | Notes |
| --- | --- | --- |
| Electron Desktop | Yes | All phases. |
| Web Desktop / Web Canvas | No (recorded exception) | The web shell file browser (`shell/src/components/file-browser/`) is a separate implementation. The redesign is a follow-up once the desktop version is approved. Needs reviewer approval as a parity exception. |
| Web Mobile / Native Mobile | No | Files has no equivalent surface there in this release. |

## Decisions (approved 2026-11-24)

1. Icons in Files use Lucide through a design-system `Icon` wrapper (library decision 2026-09-30). The rest of the app keeps Hugeicons.
2. Card and row borders use the library `--border` (neutral-300). The desktop's `--border-subtle` is already that value.
3. Dialog radius 16px (`--radius-xl`).
4. Light and dark both ship, using tokens only.
5. `OSWindow` already draws the window controls; Files does not draw its own.
6. Backend in this release: live updates (wire the desktop to the existing `file:change` WebSocket event), Trash per-item delete and restore-to-folder, conflict policy. Everything else in the brief's backend list is later.
7. The web shell is out of scope (see surfaces).

## Design-system layer

The desktop and the library disagree on token names: the desktop `--accent` is neutral-800 (the library's `--primary`), while the library `--accent` is neutral-100. Redefining library names inside Files would break reused desktop components (preview, sharing) that read the desktop meaning.

So the library's semantic tokens are exposed with a `ds-` prefix (`--ds-background`, `--ds-primary`, `--ds-accent`, `--ds-tint-info-fill`, …) in `desktop/src/renderer/src/design/ds/tokens.css`, and as Tailwind utilities (`bg-ds-primary`, `text-ds-ui`, `rounded-ds-control`, `shadow-ds-lg`). Surfaces, text, border and primary point at the desktop theme variables so every workspace theme keeps working; tints, ring and destructive use the library values in light and derived values in dark.

Components live in `desktop/src/renderer/src/design/ds/` and follow the library's variants and sizes: `Icon`, `Button`/`IconButton`, `Badge`, `Checkbox`, `Switch`, `SegmentedControl`, `Tabs` (pill, line), `Menu` (dropdown and context, on the library's `menu-styles`), `Tooltip`, `Avatar`/`AvatarGroup`, `Input`.

## Intended behaviour by phase

- **P0** Design-system layer, then Files building blocks: sidebar and nav rows, folder tabs, toolbar, file card, file table and row, selection bar, status bar, file tile, and a pure selection model (click, ⌘-click, Shift-click, ⌘A, Esc).
- **P1** New layout behind the `desktop-files-redesign` PostHog flag: sidebar (Matrix home, Locations, organization drives moved out of the tab strip, Trash), folder tabs, header and toolbar, home grid, list view with multi-select, details panel (Preview and Details; Activity and Tags hidden). Recent, Starred, Shared with me and storage stay hidden until their backend exists.
- **P2** Actions on existing APIs: context menu, inline rename, Move to…, copy/cut/paste, duplicate, trash with undo, search, New menu, upload tray, download.
- **P3** Trash page and all states and dialogs; remove the Trash modal; turn the flag into the default.
- **P4** Approved backend items, each behind its own flag with gateway tests.
- **Public docs** A separate PR in `FinnaAI/matrix-os-site` under `content/docs/` describes the redesigned Files (locations, views, selection, details, Trash) and ships when P3 makes the redesign the default. Docs are not published while the redesign is behind the flag.

The old Files UI remains the default until P3 ships, so no partial UI reaches users.

## Acceptance checks

- Each design-system component has tests for its roles, states and keyboard behaviour; Files blocks have tests for selection and keyboard navigation.
- Screens 01–03 match the mockups at 1280px in Electron Desktop and reflow down to about 900px.
- Existing preview, QuickOpen, sharing and download keep working with the flag on and off.
- `pnpm --dir desktop typecheck`, the relevant Vitest suites, `bun run check:patterns` and react-doctor pass.
- Every PR has Electron Desktop screenshots and a recording next to the matching mockup.
- The public-docs PR in `FinnaAI/matrix-os-site` is merged when the flag becomes the default.

## Security, failure modes and resources

P0–P3 add no endpoints and no persistence. They reuse the existing `/api/files/*` routes, which keep their current auth, path validation (`resolveWithinHome`) and body limits. UI error states use `toUserMessage` and never show raw server text. Live updates reuse the existing authenticated gateway WebSocket; the subscription is removed on unmount and on runtime switch. P4 items get their own security notes in this spec before they are built.

## Risks

- Token drift between the library and desktop themes: covered by mapping to desktop variables and the existing `design-tokens` test, which fails on undefined variables.
- Two Files UIs during rollout: the flag keeps one path active per user; P3 removes the old one.
- Overlap with [ENG-507](https://linear.app/matrix-os/issue/ENG-507) (Trash actions): coordinate before P3.
