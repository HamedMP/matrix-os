# Figma-aligned project sharing evidence

These reference captures render the production collaboration components with synthetic, schema-valid fixtures. No customer accounts, messages, identifiers, or credentials were used. They are visual review aids; authenticated Web Canvas, Web Desktop, and Electron Desktop journeys remain the acceptance evidence for the exact PR head.

Design reference: [Desktop app — project collaboration](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=1433-19805&t=TwMNL6hytu7csT6d-1). The implementation follows the related Share dialog (`1463:536`), published project (`1457:20614`), and shared group Chat (`1697:4411`) frames.

## Captures

### First project share — shared desktop presentation

`01-first-share-web-desktop.png` renders the production `ProjectSharingDialog` before publication. It shows the selected organization name (**Aperture Research**), the first-share **Everyone in Aperture Research · Editor** default, immutable owner, concise whole-project warning, revision-bound inventory, readiness, project Chat roots/Git status, and an external reference that stays private.

### Published access manager

`02-published-access-manager.png` renders the published state of that same dialog. It shows immutable **Owner**, organization-wide **Editor** access, activated and pending members, and inherited Editor precedence over a weaker direct Viewer grant. The scrollable published dialog also retains the owner-funded **Editor AI** source, model, and consent controls.

### Shared Chat — Editor

`03-shared-chat-editor.png` renders the production `SharedChatPanel` with an inherited project Chat scope and available owner runtime. It shows attributed human prompts on the right, assistant and tool output on the left, **Project access**, and the enabled Editor AI composer with the shared-project audience note.

## Intended differences from the Figma reference

- No **Copy link** action ships in this change. Public project links and copy-link flows are explicitly deferred in issue #2223.
- The existing topbar and **Shared with me** placement are unchanged by specification.
- Project Chats inherit the project audience; private per-member Chat snapshots were rejected.

## Capture method

The three states were rendered at `1440×1200` (dialogs) and `1440×980` (Chat) from a temporary Vite harness that imported the production components and Electron design tokens directly. The fixture shapes match the contracts exercised by `tests/ui/project-sharing-figma-dialog.test.tsx` and `tests/ui/shared-chat-controls.test.tsx`. Each PNG was inspected at original resolution after capture, and the temporary harness was removed afterward.

## Validation represented by this change

- Changed project-sharing, shared-Chat, and legacy-access UI suites: 61 tests passed.
- Project publication transition suite: 23 tests passed and 1 environment-specific test skipped, including explicit **Restricted** preservation.
- Gateway collaboration rerun: 47 tests passed serially after the parallel run hit test-hook resource timeouts.
- UI, Web Desktop, and Electron Desktop TypeScript checks passed.
- Web production and Electron Desktop production builds passed.
- React Doctor changed-scope score: 87/100, with only maintainability-complexity warnings.

## Live-evidence gate

These component captures do not replace exact-head live validation. Before merge, the preview must be verified against its reported build SHA and current screenshots/recordings must cover Web Canvas, Web Desktop, and Electron Desktop. The PR remains gated on that evidence, Greptile 5/5, and the full required CI suite.
