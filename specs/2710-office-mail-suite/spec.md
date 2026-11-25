# 2710: Docs, Sheets and Google Calendar with a tracked-changes document engine (Mail and Outlook follow)

Linear: [ENG-542](https://linear.app/matrix-os/issue/ENG-542/add-mail-calendar-docs-and-sheets-apps-with-a-tracked-changes-document)
Stack: `eng-542/01-office-engine-core` to `eng-542/10-calendar-app` (GitHub native stack, cut from the `office-mail-suite-poc` proof of concept)

## Delivery

The work ships in two parts that share ENG-542 (owner decision, 2026-11-25).

1. **This stack: Docs, Sheets and Google Calendar.** The document engine, app file
   access, the shared office UI kit, the Docs and Sheets apps, the agent document
   tools, the Google Calendar scheduling actions with the calendar provider layer, and
   the Calendar app. Calendar ships with Google Calendar only; the owner tested it
   against a live account on the preview.
2. **Follow-on: Mail and Outlook.** The Mail app and its Gmail actions stay on the
   proof-of-concept branch until Mail moves to Matrix's direct Gmail connection.
   Outlook mail and Outlook Calendar are untested (no account) and come with a direct
   Microsoft connection (see the comment on ENG-355). Nothing in this stack ships a
   mail surface, a mail action or an Outlook action, and the Calendar app offers no
   Outlook calendar: an owner with only an Outlook calendar connected sees the normal
   "Connect a calendar" state.

**Public docs deliverable.** Each stack also needs a separate documentation PR in the
private `FinnaAI/matrix-os-site` repository under `content/docs/`, alongside its
implementation and tests. For this stack it covers the Docs and Sheets apps (open,
edit, save, track changes, reviewing agent edits), the agent document tools and the
Calendar app on Google Calendar; the follow-on stack's PR covers Mail and Outlook. The PR is opened in that repository and
linked from ENG-542.

Sections below describe the whole design. Items marked *follow-on* are not part of
this stack.

## Goal

Give Matrix first-party mail, calendar and office capabilities. The owner works on
real `.docx` and `.xlsx` files and real mailboxes and calendars. The agent works
beside them, and every agent edit arrives as a change the owner accepts or rejects.
Nothing is sent, invited or finalized without an explicit owner action.

## Scope

| Area | Stack | In | Out (later) |
| --- | --- | --- | --- |
| Document engine | This stack | Lossless OOXML open/save, `.docx` model, native tracked revisions, accept/reject, comments, compare two documents, `.xlsx` model, formula engine, cell change journal | Pixel-exact pagination, charts, pivot tables, `.pptx`, PDF |
| Docs app | This stack | Open/edit/save `.docx`, track-changes mode, revision review, comments, outline, agent edits as tracked changes, defined terms and cross-reference preview, compare | Page layout fidelity, real-time multi-user co-editing |
| Sheets app | This stack | Open/edit/save `.xlsx` and `.csv`, formulas, formatting, sheet tabs, agent edits as reviewable cell changes | Charts, pivots, macros |
| Mail app | Follow-on | Gmail and Outlook: folders/labels, thread list, reading pane, search, triage, composer with redlines, agent drafts, bulk drafts | Push notifications, offline |
| Calendar app | This stack: Google Calendar. Follow-on: Outlook | Day/work week/week/month/agenda, free-busy overlay, proposals on the grid, invites the owner approves | Rooms/resources |
| Agent tools | This stack: document and sheet tools, and the Google Calendar actions through the connected-service tools. Follow-on: mail tools | Document, sheet, mail and calendar tools for Chat and coding agents | Scheduled routines |

First surface: Web Desktop. The apps are ordinary default apps, so they also load on
Web Canvas and Electron Desktop; Electron needs bridge parity (in scope, best effort).
Web Mobile and Native Mobile: out of scope; the apps are not offered on mobile in this stack.

## Architecture

1. **`packages/office` (`@matrix-os/office`)**: pure TypeScript, zero runtime
   dependencies, no Node built-ins, runs in Node and the browser.
   - `opc/`: ZIP container and OPC package (content types, relationships). Uses the
     platform `CompressionStream`/`DecompressionStream`. Parts the engine does not
     understand are kept byte-for-byte.
   - `xml/`: lossless XML parse and serialize (a parsed and re-serialized part is
     byte-identical unless edited).
   - `docx/`: document model, numbering and style resolution, edit operations that
     write native revisions (`w:ins`, `w:del`, move and formatting changes),
     revision list/accept/reject, comments, compare, new-document creation.
   - `xlsx/`: workbook model, shared strings, styles and number formats, formula
     parser/evaluator/dependency graph, function library, cell change journal, CSV.
   - `redline/`: word-level text diff with move detection, shared by docx compare and
     the mail composer.
   - `agent/`: bounded outline/text serializers for prompts and a JSON edit-operation
     schema the agent emits; operations are validated before they are applied.
2. **Engine in apps**: default apps are isolated pnpm projects, so the engine source is
   mirrored to `home/apps/_shared/office-engine/` by `scripts/sync-office-engine.mjs`.
   Apps import it by relative path. The mirror is generated and git-ignored, never
   committed: app builds, `scripts/build-default-apps.mjs`, the vitest global setup and
   the dev scripts regenerate it first. It ships in the host bundle's `home/`, so the
   owner's computer rebuilds apps from that copy (see `packages/office/README.md`).
3. **App bridge**: new `window.MatrixOS.files.*` (list, stat, read, write with version
   check) backed by `/api/bridge/files/*`, limited to first-party apps whose manifest
   declares the `files` permission. "Open with": Files writes an open request for the
   target app and launches it; the app reads the request on load and on data change.
4. **Apps** under `home/apps/{docs,sheets,calendar}` (this stack) and `home/apps/mail`
   (*follow-on*): Vite + React, pure model modules with unit tests in
   `tests/default-apps/`, shared UI in `home/apps/_shared/office-ui/`, shared
   account/provider layer in `home/apps/_shared/office-accounts/` (calendar contract
   and the Google adapter in this stack; mail and Outlook adapters *follow-on*).
5. **Mail and calendar providers**: apps call `MatrixOS.service(...)`. Google Calendar
   uses its existing read actions plus four new approval-gated scheduling writes and a
   free-busy read (this stack). Gmail compose actions and the Outlook mail and calendar
   actions are *follow-on*.
6. **Agent tools**: one definition, two registrations (kernel IPC server and the
   integrations MCP server), calling gateway `/api/office/*` routes that run the engine
   on owner files.

## Hard rules for implementers

- Each implementer edits only the paths it owns and commits only those paths.
- Do not edit: `shell/src/components/Desktop.tsx`, `shell/src/components/canvas/CanvasWindow.tsx`,
  `tests/desktop/app-launcher.test.tsx`, `packages/gateway/src/agent-launcher.ts`, and in
  `packages/gateway/src/integrations/`: `gmail.ts`, `routes.ts`, `pipedream*.ts`,
  `call-handler.ts`, `call-outcome.ts`, `action-execution.ts`, `read-call.ts`,
  `collection-hook.ts`, `jev-*.ts`, `native-gmail/**`. Open pull requests rewrite them.
  New behaviour goes in new files with a one-line registration.
- New integration actions never use `risk: "destructive"`. Every new write action is
  added to `MANAGED_WRITE_ACTIONS` in `packages/kernel/src/hooks.ts`.
- Tests first. Tests live under `tests/` and import source by relative path.
- No new npm dependency unless the exact version is already in a lockfile in this repo.
- All repository patterns in `CLAUDE.md` apply (timeouts on fetch, bounded maps, body
  limits, no bare catch, no raw provider errors to clients, files under 500 lines where
  possible and never above 1000).

## Security

- **Auth**: `/api/bridge/files/*` and `/api/office/*` sit behind the existing gateway
  auth. Bridge file routes bind the trusted app identity in the shell, require the
  `files` manifest permission and first-party trust, and validate every path with
  `resolveExistingFileApiPath` / `resolveWritableFileApiPath` (protected home paths
  stay unreadable and unwritable).
- **Input validation**: Zod 4 schemas at every route boundary, `bodyLimit` on every
  mutating route, 10 MiB file cap, bounded list sizes.
- **Untrusted content**: document text, cell text and mail bodies are untrusted. Mail
  HTML is sanitized to an allowlist and rendered without scripts, forms or remote
  loads by default. Text handed to the agent is wrapped as external content. ZIP
  reading enforces entry-count, per-entry and total-size limits (zip-bomb defence);
  XML parsing has no DTD or entity expansion.
- **Owner control**: the agent may create drafts, proposed revisions and proposed
  events. Sending mail, sending invites and accepting or rejecting revisions through
  agent tools requires owner approval. In the apps, sending is always an explicit click.
- **Errors**: generic messages to clients; details are logged server-side.

## Failure modes

- **Concurrent save**: writes carry the version read; a mismatch returns a conflict and
  the app keeps the local document visible and offers reload or save-as.
- **Corrupt or unsupported file**: the engine returns a typed error; the app shows an
  explanation and never overwrites the file.
- **Provider failure or timeout**: 10 s timeouts; the app shows a retryable error and
  keeps cached data visible.
- **Partial bulk drafts**: each draft is independent; failures are listed per row.

## Resource limits

- Files up to 10 MiB; ZIP limits as above; formula recalculation is bounded by cell
  count and iteration depth; in-memory caches are size-capped with eviction.

## Acceptance checks

1. A `.docx` opened and saved with no edits has byte-identical parts.
2. An agent edit to a `.docx` appears as tracked revisions that can be accepted or
   rejected one by one; the saved file is valid for independent readers.
3. Comparing two `.docx` versions yields a document with tracked revisions.
4. A `.xlsx` with formulas recalculates after an edit; an agent edit shows old and new
   values per cell and can be accepted or rejected.
5. Calendar on Google Calendar: five views, free-busy overlay, agent proposals
   highlighted, invite sent only after the owner confirms. The four Google Calendar
   writes ask for owner approval when an agent calls them.
6. An owner with no Google Calendar connected, including one with only an Outlook
   calendar, sees "Connect a calendar"; the app calls no calendar action.
7. No Gmail, Outlook mail or Outlook Calendar action is added, and no mail surface ships.
8. *Follow-on.* Mail: list, read, search, file and draft; an agent draft shows redlines;
   send requires a click. Outlook Calendar in the Calendar app.
9. `bun run typecheck`, `bun run check:patterns` and the new test suites pass.
10. The `FinnaAI/matrix-os-site` documentation PR under `content/docs/` for Docs, Sheets,
    Calendar and the agent document tools is open and linked from ENG-542.

## Surface matrix (Docs, Sheets and Calendar; each PR body carries the current status)

| Surface | UI | Behavior | State/recovery | Automated tests | Real evidence |
| --- | --- | --- | --- | --- | --- |
| Web Canvas | pending | pending | pending | pending | pending |
| Web Desktop | pending | pending | pending | pending | pending |
| Electron Desktop | pending | pending | pending | pending | pending |
| Web Mobile | N/A (not offered on mobile in this stack) | N/A | N/A | N/A | N/A |
| Native Mobile | N/A (not offered on mobile in this stack) | N/A | N/A | N/A | N/A |

Stakeholder review of scope and of the "nothing is sent without approval" rule is
recommended before Calendar ships and again before Mail does.
