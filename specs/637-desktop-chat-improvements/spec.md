# Desktop Chat improvements (ENG-461)

## Source and decisions

- [Requester message and six screenshots](https://matrixos.slack.com/archives/C0C3ZFXQ83W/p1792424251016989)
- [Desktop design section](https://www.figma.com/design/USFVlYYFZ3WKJBAzFZSceC/Desktop-app?node-id=2343-13253)
- Both Electron and Web Desktop have parity. Browser redesign is deferred; Electron Browser access remains.
- A project chat appears in its project and in its status group. Each placement references the same chat ID and state.
- Archive preserves history until confirmed permanent deletion. A six-second Undo reverses a completed archive.
- Side chat is a saved owner-scoped child conversation. It reads the latest committed main context and its own transcript, and can only answer without tools or writes. Sending an answer to main fills an editable draft.
- Closing an active Terminal tab confirms, then stops the associated session.

## Gateway contracts

1. Authenticated `PATCH /api/chats/:chatId/lifecycle` accepts `{lifecycle, baseRevision}`. The owner and revision are checked in the write transaction. Archive rejects active runs; restore preserves history. Commit emits a navigation event. `archived_at` is set on archive and cleared on restore.
2. Authenticated `POST /api/projects/:projectId/chats/archive` operates transactionally on the owner's active chats in that project. It skips chats with active runs and returns archived and skipped counts and IDs for Undo. Revision changes and events follow committed writes.
3. Group/project navigation uses independently cursor-paged owner-scoped queries. Each status group starts with 10 rows, project groups with 5, and Show more requests 20. Counts are returned independently of loaded rows; no 1,000-chat cap controls discoverability.
4. Search covers titles and committed message text across all owner chats and accepts an active or archived lifecycle filter. Archived browse orders by archive time. The response is bounded and paginated.
5. Side-chat creation and turns validate owner and source chat. The server, rather than a client permission setting, enforces a read-only execution policy with no mutating tools. Side chats remain absent from ordinary navigation and search.

## Repository extraction

`packages/gateway/src/chat/repository.ts` already exceeds 1,000 lines. Keep the public repository facade stable while moving lifecycle, bulk archive, and navigation/search SQL into focused modules with the same transaction owner and database dependency. Move new archive/search assertions out of the existing oversized `tests/gateway/chat-repository.test.ts` into focused test files with shared fixtures. Finish this extraction before merge so ownership and review boundaries are clear.

## Security and wiring

| Route | Method | Authentication and authorization | Public |
| --- | --- | --- | --- |
| `/api/chats/:chatId/lifecycle` | PATCH | Gateway verified principal; personal chat owner; matching revision; archive excludes active runs | No |
| `/api/projects/:projectId/chats/archive` | POST | Gateway verified principal; only that owner's project chats; active runs skipped | No |
| `/api/chat-navigation/page` | GET | Gateway verified principal; owner-scoped status/project query | No |
| `/api/chats/search` | GET | Gateway verified principal; owner-scoped title and committed-message search | No |
| `/api/chats/:chatId/side-chat` | GET, POST | Gateway verified principal; main-chat owner | No |
| `/api/chats/:chatId/side-chat/turns` | POST | Gateway verified principal; main-chat and side-thread owner | No |
| `/api/chats/:chatId` | DELETE | Existing verified-principal and owner check; explicit UI confirmation | No |

The Gateway derives owner ID from its verified request principal, never from request fields. Zod validates route IDs, lifecycle values, revisions, page group and limit, search text and cursor, and side-chat text and request IDs at the boundary. Mutations use Hono `bodyLimit`; cursor pages and search results are capped at 100, side-chat prompts and transcripts are bounded, and the generation call has a 90-second abort signal. The side-chat generator receives an empty tool set and denies tool calls server-side; its transcript is stored separately from main-chat messages. Failed provider calls return a generic client error and release the side-thread lease.

The chat routes mount inside the authenticated Gateway app; navigation paging uses the registered chat navigation repository, and side-chat routes resolve their repository and generator when the server registers them. Archive and bulk archive commit their writes and outbox notifications in a transaction. The clients refresh navigation only after successful mutations; a pending Undo uses the returned post-archive revision. Search cursors bind the query and filters and use stable `(updated_at, id)` ordering.

## UI behavior

- Both desktops show Projects plus Needs you, Working, Done; Electron's existing shared/Drive access and Web's organization Drive Projects remain accessible.
- Row actions respect active-run restrictions. Archived list supports multi-select Restore and confirmed Delete. Project Archive all reports skipped running chats.
- Right panel tabs: Files, Terminal, Side chat. Files show tree above a full-width preview separated by a draggable horizontal divider. Panel layout is saved per verified user, runtime, and chat. Width is 240–820 px, main chat is at least 360 px, drag under 192 px closes, double-click resets to 400 px.
- Terminal tab close stops its session after active-session confirmation. Side chat transcript persists and Send to main inserts an editable composer draft.

## Verification

- Red/green production-boundary tests cover owner isolation, revision conflicts, active runs, bulk skip/Undo, search beyond 1,000 chats, independent paging, duplicate placements, read-only side-chat policy, and terminal close.
- Publish the separate public documentation PR in `FinnaAI/matrix-os-site` under `content/docs/`, covering archive, search, and Side chat instructions: [site PR #354](https://github.com/FinnaAI/matrix-os-site/pull/354).
- Validate exact build in live Electron and Web Desktop at normal and narrow widths in light and dark themes. Attach distinct captures for both surfaces to each affected PR and Slack `#tech`, with exact commit/build and fixture limitations.
- CI and Greptile must pass before merge. Product/design/engineering owners should review the substantial behavior and visual changes.
