# Company Brain app

The shared view of the Company Brain (spec 563) over the `/api/brain` routes. Web Desktop, Web Canvas, Web Mobile
and Electron Desktop render it through thin adapters: `shell/src/components/brain/` (Web) and
`desktop/src/renderer/src/features/brain/` (Electron Desktop).

## Scope

- Owns `BrainApp`, its six tabs, the typed client `createBrainShellApi`, the controls in `brain-controls.tsx`,
  the tone classes in `brain-tone.ts`, and the view shapes in `brain-types.ts`.
- Opens on Chat (spec 567) where the surface lends a chat view, else on Search: tabs Chat, Today, Decisions,
  Timeline, Search and Sources sit in one row next to the project picker, Chat first and in bold. Older ids still
  open: `ask` is Search, `commitments` and `risks` open Decisions on that kind; Decisions switches between decisions,
  commitments and risks.
- Chat (`BrainChat.tsx`) is an ordinary Matrix Chat run by the owner's Company Brain Bot, never a second chat system: no
  stream, request, transcript or composer of its own. It finds the Bot (`company-brain-bot.ts`; the library lists active
  Bots only. Bots off, no brain recipe (a gateway with no runtime host lists none), or a 503 from the recipe, Start or
  thread list calls, reads as not running; none shows a one-time Start card that creates it with no model, so the server
  picks Automatic, and a request id fixed per recipe version; when that replays a Bot the owner archived since, Start
  asks again with a request id made from the archived Bot, so a new Bot is made once, at most 5 times in a row, then it
  says it was archived), lists the project's brain chats (`use-brain-threads.ts`, 50 a page, "Show more" pages kept
  through a reload whose first page lost none of its chats; on open, on focus, when a thread is created and after every
  admitted turn the view reports) and hands the surface's chat view a slot (`BrainChatHost.render`) with the empty
  chat's heading and line. Opening order: the chat this viewer had open last for the project if it is still listed
  (later pages load to find it), else the newest, else a draft; the chat it opens is remembered. A draft saves nothing
  until its first send, which makes one thread however often the view asks, and the slot shows it at once; a send after
  a failed create keeps the draft's first request id, so the server replays a thread it saved. A project with no source
  shows "Connect this project's repository in Sources first." in place of a new chat, checked again on focus and on
  "Check again", and a brain that is off shows its error there; saved chats still list and open. Rows
  (`BrainChatList.tsx`) rename and delete through `ChatContextMenu` and the host's `rows`. Narrow screens fold the list behind a "Chats" button, with focus moved in and back. Open in Chat shows the
  same Chat in the Chat app.
- View logic only: request order, polling, wording and layout. Every rule about what the brain holds (storage, sync,
  extraction, ranking, merges, budgets) lives in the gateway (`packages/gateway/src/brain/`).
- Search (once Ask) shows a path's history (the why route) when the question is a repo path: no spaces and a "/" or a file ending,
  a leading "./" dropped, and no leading "/" or empty, "." or ".." segment. "Search the words instead" shows in every
  state of the history, loading and errors included.
- Timeline's person view lists possible duplicates (merge suggestions) with Merge and Undo over the alias route; Undo
  sends `unmerge`, which leaves nothing behind, never a lasting split. One Merge or Undo runs at a time in the list,
  and a card naming a person another merge there moved away cannot merge until that merge is undone (the person now
  resolves to the one who stayed). Empty states show an icon, a headline, the next step and maybe Open Sources.
- Sources lists every kind with its availability ("Not set up on this server" for `not_configured`, which covers
  every server-side gap), connects with per-kind settings, and runs the repository's sync and claim reading, and
  every other source's sync, as background jobs it polls. On open it reads `GET .../jobs?limit=20` once and each card
  follows the newest queued or running job of its slot, so a reload shows a run still going and keeps its buttons
  off. The repository card shows the owner's background model work (claims) for the last 30 days across all
  projects, and the model confirm the budget left (`modelSpend` of `GET .../claims`); chat answers are billed like any
  Chat, not from this budget. A run that waits for another run of the project says so.
- Every screen is one shrinkable grid column, and long titles, keys and selects shrink or wrap, so nothing is wider
  than a 390 px screen.
- Colors come from `BRAIN_TONE`: each class chains the Electron Desktop token first and the Web token second, with
  no `dark:` variants. Both renderers scan this folder for Tailwind classes.
- Keyboard focus (`BRAIN_TONE.focus`) is a 2 px outline in the ring color on Web; Electron Desktop's global focus
  ring replaces it. `tests/ui/brain-tone.test.ts` builds the classes with Tailwind to check it.
- Out of scope: account connections (Settings), window chrome, and where each surface registers the app (the
  adapters).

## Source Of Truth

- The gateway. `brain-types.ts` copies its view shapes, checked by `tests/ui/brain-types-compat.test.ts`, merge
  suggestions and the four job routes included. The view keeps only what is on screen; nothing is cached or
  persisted, except the id of the project this surface picked last and of the brain chat last open per project
  (`localStorage`, read and written in try/catch by `brain-memory.ts`; each is used only while still listed). Job
  answers are read field by field (`brainJobView`).
- Brain chats: the gateway's Chat records (`GET`/`POST /api/chat-agents/:agentId/threads`, through the shared Chat
  Agents client `bots.threads`). Every chat is saved on the server, so it comes back after a reload or restart and on
  every surface.

## Public API

- From the `@matrix-os/ui` root: `BrainApp` (`api` and `loadProjects` required; `initialScreen`,
  `initialProjectId`, `showHeading`, `chat`), `createBrainShellApi(transport)`, `listBrainProjects(transport)`,
  `brainShellError`, `BRAIN_SHELL_VIEW`, `BRAIN_SHELL_SCREENS`, `BRAIN_SHELL_SCREEN_ALIASES`, `BRAIN_APP_KEYWORDS`,
  and the types `BrainHttpTransport`, `BrainRequestOptions`, `BrainShellApi`, `BrainShellClient`,
  `BrainShellErrorState`, `BrainShellScreen`, `BrainShellScreenId`, `BrainProjectOption`, `BrainChatHost` and
  `BrainChatSlot`. Other files of this folder are internal.
- `BrainChatHost` is what a surface lends the Chat tab: its Chat Agents client, `render(slot)` for its own chat view,
  `openInChat`, and `rows` (rename, which sends the row's title version and may answer with the renamed record, delete
  and the menu layer over its own chat client). The slot carries the project, the Bot, the Chat (or null for a draft),
  the empty chat's heading and line, `createChat` (the first send of a draft) and `onChatChanged` (called by the view
  after every admitted turn). Without a host the tab says chat is not available here and offers Search.
- `BrainHttpTransport` is four JSON calls (`get`, `post`, `patch`, `delete`) with a per-call `timeoutMs`. A failed
  call rejects with an `Error` that has `category` (`unauthorized`, `offline`, `timeout`, `notFound` or `server`) and
  may have `detail`, a lower_snake gateway code. Anything else (another category, a plain `Error`) reads as
  "unavailable" and is logged by its name only.

## Auth And Trust Boundaries

- Calls use the renderer's gateway session; the gateway authorizes. Responses render as text; only `https://`
  permalinks become links; error text is fixed copy keyed by a known code, never the response message.
- Chat answers are written by the Bot from brain tool results only, with a Markdown link to each source; each
  surface's chat view renders them like every Chat (Web after the external link confirm, Electron Desktop in its
  Browser tab). Thread calls check the project id and request id before sending and leave out an unsafe title.
- "Find claims with the model" asks first: it sends project text to Anthropic and is billed per run.
- Job and merge answers are untrusted: a job is kept only with a valid id and status, error codes only when known,
  next actions only through a fixed table; merge reasons are fixed words around a detail cut to 200 characters,
  each shown once.

## Concurrency And Recovery

- `useBrainLoad` numbers every request and drops an answer for an older one; `replace` (a brief built again) drops a
  still-running load of the same request and anything meant for a key the screen has left. Lists stop at 500 items.
- One action at a time per card, the model confirm included. Writes send the loaded source revision.
- A chat list answer for a project the tab has left is dropped; a list that arrives late never moves the viewer off
  the chat they opened; a failed list opens a draft and offers "Try again". The open chat's title is kept apart from
  the list, and a rename or delete made here stays over the list only until the chat is read again (then the server's
  title shows, a later rename elsewhere too) or is not listed, at most 500 of them. A rename keeps the new title
  version (the host's answer, else one more), so a chat not read again since can be renamed again. A delete that
  settles moves the viewer only if the deleted chat is still the open one.
- Proxies in front of the gateway end a request at 30 s, so repository runs and source syncs start a job (202) and
  poll it: 1 s, then doubling to 10 s, at most 90 polls; three failed polls in a row, or one refused poll, stop with
  "Try again", and the poll cap with "Check again". Stop asks the gateway to cancel. A gateway without the jobs route
  (or that kind of job) runs the action directly (so does a gateway whose worker runs another owner's jobs:
  `job_kind_unavailable`); only a direct model run cut short on its way back (too slow, or a 500 without a known
  code) is worded as "may still be finishing". A failed job start ran nothing and shows its error. A failed job is
  worded by its known code, else by the next action its last pass reported (for example "Connect the account in
  Settings").
- A new job, "Check again" or unmounting drops every answer meant for the older one; the end of a job is reported
  once, whichever answer (a poll or the cancel) brings it.

## Tests

- `tests/ui/brain-*.test.ts(x)` (fake client, jsdom, no network; `brain-chat`, `brain-company-bot` and the static
  `brain-chat-boundary` cover the Chat tab) and the type check of `tests/ui/tsconfig.brain-compat.json`; the adapters
  have `tests/shell/brain-shell.test.tsx`, `tests/shell/canonical-chat-thread.test.tsx`,
  `tests/desktop/brain-desktop-view.test.tsx` and `tests/desktop/brain-chat-tab.test.tsx`.
