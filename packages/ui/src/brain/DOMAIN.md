# Company Brain app

The shared view of the Company Brain (spec 563) over the `/api/brain` routes. Web Desktop, Web Canvas, Web Mobile
and Electron Desktop render it through thin adapters: `shell/src/components/brain/` (Web) and
`desktop/src/renderer/src/features/brain/` (Electron Desktop).

## Scope

- Owns `BrainApp`, its seven screens, the typed client `createBrainShellApi`, the controls in `brain-controls.tsx`,
  the tone classes in `brain-tone.ts`, and the view shapes in `brain-types.ts`.
- View logic only: request order, polling, wording and layout. Every rule about what the brain holds (storage, sync,
  extraction, ranking, merges, budgets) lives in the gateway (`packages/gateway/src/brain/`).
- Ask shows a path's history (the why route) when the question is a repo path: no spaces and a "/" or a file ending,
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
  off. The repository card shows the owner's model spend for the last 30 days across all projects, and the model
  confirm the budget left (`modelSpend` of `GET .../claims`). A run that waits for another run of the project says so.
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
  persisted, except the id of the project this surface picked last (`localStorage`, read and written in try/catch;
  the app opens on it while it is still listed). Job answers are read field by field (`brainJobView`).

## Public API

- From the `@matrix-os/ui` root: `BrainApp` (`api` and `loadProjects` required; `initialScreen`,
  `initialProjectId`, `showHeading`), `createBrainShellApi(transport)`, `listBrainProjects(transport)`,
  `brainShellError`, `BRAIN_SHELL_VIEW`, `BRAIN_SHELL_SCREENS`, `BRAIN_APP_KEYWORDS`, and the types
  `BrainHttpTransport`, `BrainRequestOptions`, `BrainShellApi`, `BrainShellClient`, `BrainShellErrorState`,
  `BrainShellScreen`, `BrainProjectOption`. Other files of this folder are internal.
- `BrainHttpTransport` is four JSON calls (`get`, `post`, `patch`, `delete`) with a per-call `timeoutMs`. A failed
  call rejects with an `Error` that has `category` (`unauthorized`, `offline`, `timeout`, `notFound` or `server`) and
  may have `detail`, a lower_snake gateway code. Anything else (another category, a plain `Error`) reads as
  "unavailable" and is logged by its name only.

## Auth And Trust Boundaries

- Calls use the renderer's gateway session; the gateway authorizes. Responses render as text; only `https://`
  permalinks become links; error text is fixed copy keyed by a known code, never the response message.
- "Find claims with the model" asks first: it sends project text to Anthropic and is billed per run.
- Job and merge answers are untrusted: a job is kept only with a valid id and status, error codes only when known,
  next actions only through a fixed table; merge reasons are fixed words around a detail cut to 200 characters,
  each shown once.

## Concurrency And Recovery

- `useBrainLoad` numbers every request and drops an answer for an older one; `replace` (a brief built again) drops a
  still-running load of the same request and anything meant for a key the screen has left. Lists stop at 500 items.
- One action at a time per card, the model confirm included. Writes send the loaded source revision.
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

- `tests/ui/brain-*.test.ts(x)` (fake client, jsdom, no network) and the type check of
  `tests/ui/tsconfig.brain-compat.json`; the adapters have `tests/shell/brain-shell.test.tsx` and
  `tests/desktop/brain-desktop-view.test.tsx`.
