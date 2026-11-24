# Team terminals in the Terminal window

**Status:** Draft for review
**Tracking:** [ENG-570](https://linear.app/matrix-os/issue/ENG-570/team-spaces-and-collaborative-terminals-in-the-terminal-window)
**Builds on:** [121 collaboration and session sharing](../121-collaboration-session-sharing/spec.md) (terminal roles, control), [124 organization collaboration](../124-organization-collaboration/spec.md) (org membership authority), [2706 Terminal window](../2706-terminal-window-herdr/spec.md) (Spaces sidebar), [2689 collaborative app sharing](../2689-collaborative-app-sharing/spec.md) (the precedent for an exception to 124's standalone freeze).

## Goal

An owner shares one live terminal on one of their Matrix computers with
chosen people in their organization, as **viewer** (watch only) or **editor**
(can type). Those people see it in the Electron Terminal window's Spaces
sidebar under **Team**, labelled with the owner's name ("Nima's MacBook",
"Yuhan · matrix-demo"). Everyone in a shared terminal sees the same output.
They can see who is watching and who typed what. Editors type together, including
prompts to agents running in the terminal. The owner can take control back or
stop sharing at any time. Revoking access closes the person's socket at once.

The first target computers are the shared 128 GB team dev VMs. This spec does
not provision them.

## Product rules

1. **Explicit share only.** Nothing appears under Team unless its owner shared it.
   Being in the same organization grants nothing by itself.
2. **A terminal is full shell access.** An editor can do anything the owner's
   shell user can do on that computer. That includes reading the owner's agent
   credentials and machine credential. A viewer sees everything printed,
   including secrets. The share confirmation says this plainly and suggests team
   VMs rather than personal computers.
3. **Two roles.** `viewer`: output only. The gateway rejects every input,
   paste, resize and stop frame. `editor`: can type and paste. Only the owner
   can stop the program, change roles or stop sharing.
4. **The owner is in charge.** The owner's computer gateway authorizes every
   attach and every input frame against current state. The platform routes
   tickets and bytes, and it caches metadata only. The owner can switch the
   terminal to **owner-only input** ("take control") and back, and can revoke
   one person or unshare the whole terminal at any time.
5. **Attribution, not recording.** Presence and who-typed-what are shown live.
   Matrix stores no keystroke content. It keeps only content-free marks (actor,
   time, terminal output position, byte count, whether Enter was pressed).

## Relationship to existing specs (decisions)

- **124 freezes new standalone terminal scopes.** This spec adds a second
  narrow exception beside 2689's app exception: a `terminal` scope whose
  audience is people in the owner's current organization. Project, chat, file
  and folder standalone scopes stay frozen. The project share in 124 is
  unchanged. Terminals in org-shared projects keep inheriting the project's
  full access.
- **Roles.** The exception reuses 121's existing `owner/editor/viewer` roles and
  the existing `collaboration_members` and organization grant rows. It adds no
  new permission system. Constitution I lets an owner delegate personal
  resources without transferring them, and VII's app clause does not apply to
  terminals. Reviewers should still confirm the constitution check (see Risks).
- **Control model.** 121 allowed one input controller at a time. Hamed asked
  for people to type together. The default for a team terminal is therefore
  **shared input**: every connected editor's frames are accepted in arrival
  order. The existing lease coordinator (`terminal-control.ts`) runs the
  **owner-only** mode. When the owner takes control, a lease held by the owner
  blocks all collaborator input. Handing control back releases the lease. The
  121 `acquire/renew/takeover` actions stay for compatibility and are not used
  by new team-terminal clients.
- **Host-shell opt-in.** `collaboration_terminal_bindings.contributor_control`
  is the existing owner opt-in for collaborator input on a host shell. Sharing
  with at least one editor sets it to true; the confirmation in rule 2 is the
  opt-in. When no editors remain, it is set back to false.

## User journeys

**J1 Owner shares a terminal (P1).** In the Terminal window, Nima opens a tab's
menu, chooses **Share…**, picks people from the organization (or "everyone in
Acme") and a role for each, reads the full-shell warning, and confirms. The tab
shows a shared badge with participant avatars. *Check:* only the chosen people
can discover it; the gateway records one scope, one binding and one grant per
audience entry.

**J2 Member finds and opens it (P1).** Yuhan opens the Terminal window. Under
**Team**, "Nima's MacBook" is listed with the shared tab "api-server" beneath it.
Clicking the tab attaches a pane. Yuhan sees retained screen and then live output.
For an organization-wide grant, the first open accepts it, idempotently. *Check:*
the first byte comes only after the owner gateway authorizes. An outsider, or a
member who was not chosen, sees nothing and receives a generic 404 from ticket and
socket requests.

**J3 Type and prompt an agent together (P1).** Nima and Yuhan (editor) both type
into a running `claude` session. Each person's keystrokes reach the PTY in arrival
order. Avatars show who is typing. The pane header names who pressed Enter last
("Yuhan pressed Enter · 5s ago"); the content-free marks carry the output
position so a later change can draw them as gutter decorations.
*Check:* both prompts reach the agent; both clients show the same marks.

**J4 Viewer is read-only (P1).** Sam (viewer) watches. Sam's input UI is disabled.
A crafted input, paste, resize or stop frame is rejected by the gateway. The
terminal is unchanged and the rejection is audited without its content. *Check:*
a direct socket test shows no PTY write.

**J5 Owner takes control and gives it back (P1).** Nima clicks **Take control**.
Everyone sees "Nima has control", and editor frames are rejected with
`input_paused` (the socket stays open). Nima clicks **Hand back**, and shared input
resumes. An editor can **Ask for control**, which shows a transient request to the
owner and grants nothing by itself.

**J6 Role change, revoke, unshare (P1).** Nima changes Yuhan to viewer. Yuhan's
next input is rejected, and Yuhan's pane switches to read-only within one frame
round-trip. Nima revokes Sam: Sam's socket closes with `revoked` and reconnecting
fails. Nima chooses **Stop sharing**: every collaborator socket closes, the Team
entry disappears, and the program keeps running for Nima.

**J7 Membership loss (P1).** Removing Yuhan from the organization ends Yuhan's
access without any per-terminal cleanup. The bound is in Revocation.

**J8 Program exits or tab closes (P2).** Participants see the exit state. The scope
moves to archived and its entry leaves Team. A new tab with the same name does not
inherit the share, because the binding is tied to the tab incarnation.

## Surfaces

| Surface | Scope | Rationale |
| --- | --- | --- |
| Electron Desktop (Terminal window) | Full: Share dialog, Team section, shared pane, presence, attribution, take control | The Terminal window and its Spaces sidebar exist only in Electron (specs 651, 2706). |
| Web Desktop | N/A in this stack | The web Terminal app has no Spaces sidebar. Enforcement happens in the gateway and covers every client. Follow-up: adopt the shared sidebar from `packages/ui` (2706 already places it there). Needs reviewer approval. |
| Web Canvas | N/A in this stack | Same rationale as Web Desktop. |
| Web Mobile, Native Mobile | N/A | No Terminal window. Native Mobile collaboration parity is deferred in 124. |
| CLI | Unchanged; must not regress | `watchCollaborationTerminal` keeps working against the same stream. |

The owner's own tab socket (`/ws/terminal/tab`) is unchanged for every surface,
so typing on your own computer cannot regress.

## Architecture

Reuse, in order:

- **Scope and authority:** `collaboration_scopes(kind='terminal')`,
  `collaboration_members`, organization grants, `CollaborationAuthority.authorize`,
  and `organization-membership-client.ts`.
- **Binding:** `canonical-terminal-bridge.ts` binds the scope to one tab
  incarnation and checks the incarnation on every input.
- **Streams:** platform `POST /api/collaboration/connections` issues one-use
  tickets. The relay serves `/ws/collaboration/direct/scopes/:scopeId/terminal`,
  and the home side is `direct-websocket.ts` (handshake, 5 s watchdog on authority
  generation and evidence). `terminal-events.ts` holds per-scope replay, caps and
  `notifyScopeRevoked`. `terminal-dispatcher.ts` handles per-action role checks
  and calls `revalidate()` before each write.

New pieces, all on the owner gateway unless noted:

1. **Team-terminal exception** in `scope-routes.ts`. Preflight and create accept
   `kind:"terminal"` with an `audience` (`organization` + `defaultRole`, or up to
   32 `{actorId, role}`). Every other standalone kind is still rejected.
2. **Input mode** per bound terminal: `shared` (default) or `owner`. It is held in
   memory beside the lease coordinator and restored to `shared` after a gateway
   restart, because the lease does not survive a restart (fail-safe: no editor is
   wrongly blocked, and the owner can take control again).
3. **Presence registry**, attached to `CollaborationTerminalEventRegistry`. It
   tracks participants per scope (actor, display name, role, connection count,
   last input time) and keeps a ring of attribution marks.
4. **Owner feed.** The owner's existing `/ws/terminal/events` stream (one per
   computer, already used by `use-terminal-status`) gains `tab.collaboration`
   events, so the owner's tab shows presence and marks without another socket.
   The owner's own keystrokes on a shared tab produce marks too, emitted from the
   tab socket's input path.
5. **Desktop:** a Share dialog, a Team section, and a shared pane in the Terminal
   window. Collaborator streams open in the main process through the existing
   desktop collaboration API (`renderer/src/lib/collaboration.ts`, main-process
   header injection). The renderer never holds tickets or session keys beyond what
   the existing shared-app path already does.

The platform needs **no change** by design. The shared listing already carries
`kind:"terminal"`, `ownerId`, `runtimeId` and the grant status, and clients
already get names from the owner home (computer label, tab name, owner display
name via the participant resolver). If implementation shows a platform change is
required, it becomes its own layer and must merge and deploy to the platform
before the live preview (see Preview plan).

## Computers: VPS and owned machines

Team computers can be hosted VPSes or platform-enrolled owned machines
([2707 owned machines](https://github.com/HamedMP/matrix-os/pull/3560),
ENG-524). Both go through the same platform API, and the Team section
treats them the same way:

- Discovery uses only `GET /api/collaboration/shared`, which returns
  scope, owner and runtime IDs. It never uses handles, IPs or substrate fields.
- Tickets and streams go through the platform relay. 2707 sends every
  runtime call, including the collaboration relay, through
  `substrates.resolveUpstream`, so an owned machine behind a tunnel is
  reached exactly like a VPS.
- The computer label is chosen by the owner at share time. It defaults to
  the label the owner's client already shows for that computer, is
  bounded to 64 characters, and is stored with the scope. The owner home
  returns it on hydration, so no platform field is needed.
- An offline owned machine shows as offline (`host_offline`) in the same way
  as a stopped VPS.

## Security architecture

### Auth matrix

| Route / stream | Caller | Authentication | Authorization (owner gateway unless noted) |
| --- | --- | --- | --- |
| `POST /api/collaboration/runtimes/:runtimeId/scopes/preflight` (`kind:"terminal"`) | Owner client | Owner runtime proof (existing `ownerRuntimeIdentity`) | Actor is owner of the runtime, is a current member of `organizationId`, and the tab is live (incarnation verified). Returns an HMAC confirmation token (60 s). |
| `POST /api/collaboration/runtimes/:runtimeId/scopes` (`kind:"terminal"`) | Owner client | Owner runtime proof + confirmation token | Same as preflight, plus an exact token/incarnation match. Creates scope + binding + grants in one transaction; idempotent on `clientRequestId`. |
| `POST` / `PATCH` / `DELETE /api/collaboration/scopes/:scopeId/grants[/:grantId]` (existing preset grants) | Owner client | Owner direct session on the scope | Owner only (`manage_members`). Audience is `organization` or one `member`; preset `viewer` or `contributor` (shown as Editor). Revision is enforced in the `UPDATE`; every mutation increments `auth_epoch`, and the commit hook re-authorizes the scope's live sockets. |
| `POST /api/collaboration/scopes/:scopeId/grants/:grantId/accept` (existing) | Member client | Accept-only direct session for that exact grant | The addressee of a member grant, or any current org member for an organization grant. |
| `PATCH /api/collaboration/scopes/:scopeId/terminal` `{contributorControl}` (existing) | Owner client | Owner direct session | Owner only. Sharing with an editor records the opt-in; removing the last editor withdraws it. |
| `POST /api/collaboration/scopes/:scopeId/terminal/actions` `{type:"input_mode"}` (existing route, new action) | Owner client | Owner runtime proof | Owner only. |
| `POST /api/collaboration/scopes/:scopeId/lifecycle` `{archive}` (existing; unshare) | Owner client | Owner runtime proof | Owner only. Increments the authority generation and closes every collaborator socket. |
| `GET /api/collaboration/shared` | Member client | Clerk session at the platform (existing) | Platform: metadata for scopes whose directory entry targets the actor or the actor's current organization. Grants nothing on the home. |
| `POST /api/collaboration/connections` (purpose `terminal`) | Member client | Clerk session at the platform (existing) | Platform: the route exists and the owner runtime is registered. Issues a one-use, short-lived ticket bound to scope, actor, runtime and purpose. |
| `GET /api/collaboration/scopes/:scopeId` (hydrate) | Member client, via direct session | Direct session (existing) | `authorize(read)`. Returns terminal name, computer label, owner display name, caller role, input mode and participants. |
| `WS /ws/collaboration/direct/scopes/:scopeId/terminal` | Member client | One-use ticket in the query + session-key proof in the first frame (existing) | `authorize(read)` on open. Every client frame passes the role/mode check in the table below. A 5 s watchdog checks the authority generation and evidence. |
| `WS /ws/terminal/events` (`tab.collaboration` events) | Owner client | Existing owner gateway auth | Owner only; events only for the owner's own tabs. |
| `WS /ws/terminal/tab` | Owner client | Existing | Unchanged. Collaborators can never reach it (the preview allowlist path in `docs/dev/preview-environments.md` is separate and unchanged). |

There are no public routes. Every unauthorized case returns the same generic
`not_found` / `unavailable` response, so a scope's existence is not revealed.

### Per-frame authorization (collaborator stream)

| Frame | Viewer | Editor, mode `shared` | Editor, mode `owner` | Owner (via collab stream) |
| --- | --- | --- | --- | --- |
| `heartbeat`, `presence.typing` | allowed (typing is ignored for viewers) | allowed | allowed | allowed |
| `input_shared`, `paste_shared` | reject `forbidden`, audited | accepted after `revalidate()` | reject `input_paused`, socket stays | accepted |
| `control_request` | reject | allowed (rate-limited, 1 per 10 s) | allowed | n/a |
| `resize` | reject (canonical size is the owner's; the existing bridge already throws) | reject | reject | reject |
| `stop`, `input_mode`, audience changes | reject | reject | reject | owner REST routes only |

Before each accepted write, `revalidate()` re-reads the scope's
`authority_generation`, the member row and its role, the input mode, and whether
the membership assertion is still fresh, then writes to the PTY. A frame that
arrives after a revoke or downgrade commits is therefore rejected even if its
socket has not closed yet.

### Input validation

- Route params `scopeId` and `runtimeId` use the existing `CollaborationIdSchema`
  and `CollaborationRuntimeIdSchema`. `actorId` must match `^[A-Za-z0-9_-]{1,128}$`.
  Bodies use strict Zod 4 schemas behind Hono `bodyLimit` (16 KiB).
- `audience`: a discriminated union. Either `{kind:"organization", organizationId, defaultRole}`
  or `{kind:"people", organizationId, members: [{actorId, role}] (1..32, unique)}`.
  `role` is `"editor" | "viewer"`. Every member must be a current member of
  `organizationId`, checked in batches with the existing membership client.
- WebSocket frames are additions to `CollaborationTerminalActionSchema` in
  `packages/contracts/src/collaboration.ts`:

```ts
{ type: "input_shared", clientSeq: int 0..2^31, data: string ≤ 32 KiB (COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT) }
{ type: "paste_shared", clientSeq, data: string ≤ 32 KiB }
{ type: "presence.typing" }                      // no payload; server debounces
{ type: "control_request" }
```

- Server frames are additions to `CollaborationTerminalFrameSchema`:

```ts
{ type: "terminal.presence", participants: [{ actorId, displayName ≤120, role, connections 1..4, typingAt?: iso }] ≤ 32, inputMode: "shared"|"owner", controllerActorId?: string }
{ type: "terminal.attribution", marks: [{ actorId, at: iso, outputSeq: revision, bytes: 1..32768, enter: boolean }] ≤ 64 }
{ type: "terminal.role", role: "editor"|"viewer" }  // sent to the affected actor on change
{ type: "terminal.input_rejected", clientSeq, code: "forbidden"|"input_paused"|"rate_limited" }
{ type: "terminal.control_requested", actorId }    // owner only
```

- Owner event: `{type:"tab.collaboration", ref:{workspaceId, tabId}, scopeId, inputMode, participants, marks}`
  uses the same bounds. Older clients ignore unknown event types; the plan must
  prove this with a test against the released parser.
- Display names come only from the platform participant resolver. They are
  trimmed, at most 120 characters, and rendered as text, never HTML. Computer
  labels come from the owner's runtime record, with the same bounds.

### Error policy

Clients see only `not_found`, `unavailable`, `forbidden`, `input_paused`,
`rate_limited` or `revoked`. Logs record the error name, scope ID, actor ID and
frame type, never input content, terminal output, tickets or session keys. The
audit (`collaboration_audit`) gets content-free rows for share, audience change,
input-mode change, input rejection (bucketed at most 1 per actor per scope per
minute) and unshare.

### Credentials

There are no new secrets. Tickets and session keys keep the existing direct-session
handling (query ticket redacted from logs, key proof in the first frame). The
owner's AI credentials are not shared as a capability. A shared shell can read
whatever the shell user can read; rule 2 discloses this.

## Revocation and stale-connection eviction

| Event | Effect | Bound |
| --- | --- | --- |
| Owner revokes a person or unshares | Transaction commits the role/lifecycle change and increments `authority_generation`. After commit, `notifyScopeRevoked(scopeId, actorId?)` sends `revoked` and closes the sockets (1008). | Socket closed ≤ 1 s after commit. Later input is rejected immediately through `revalidate()`. The 5 s watchdog is a backstop. |
| Editor → viewer | The authority generation increments. Sockets stay open and the actor gets `terminal.role`. | Next input frame rejected; UI goes read-only on receipt. |
| Owner takes control | The lease is held by the owner, and the input mode changes to `owner`. | Next editor frame rejected `input_paused`. |
| Removed from organization | The membership assertion expires (platform-set TTL; the plan records the exact value). `revalidate()` refuses expired assertions and re-checks; the watchdog closes sockets whose evidence lapsed. | Organization evidence lasts 20 s (`COLLABORATION_DIRECT_LIMITS.organizationEvidenceTtlSeconds`), plus the 5 s watchdog: ≤ 25 s. |
| Tab exits or is closed | Exit is published, sockets close with 1000, scope → archived, binding removed. | Immediate. |
| Owner gateway restart | All collaborator sockets drop; clients reconnect with fresh tickets; mode resets to `shared`. | Reconnect after backoff. |
| Silent network partition | The existing registry sweep evicts connections with no heartbeat for `STALE_AFTER_MS` (30 s), and the presence entry goes with it. | Sweep interval. |
| Gateway shutdown | Shutdown drains collaborator sockets with `unavailable` before it destroys the authority, membership client or DB. Presence timers are cleared. | On shutdown. |

## Resource caps

Existing caps are kept: 256 collaborator connections per gateway, 32 per scope,
4 per actor per scope, 2 MiB replay, 64 KiB WS frame, 16 frames in flight,
8 pre-handshake frames, 2 MiB pending output per viewer, and 256 control-lease
entries with a sweep.

New caps:

- 64 shared terminal scopes per owner runtime (create returns `unavailable` beyond this).
- 32 audience entries per scope.
- Input per actor per scope: 64 KiB/s and 200 frames/s (token bucket). Frames over
  the limit are rejected `rate_limited`; three consecutive seconds over the limit
  close the socket.
- Attribution ring: 512 marks per scope, FIFO eviction. Only the last 64 are sent
  on attach. Marks are dropped when the scope is archived.
- Presence: one entry per participant actor (≤ 32); typing state expires after 3 s.
  Presence frames are coalesced to at most 4/s per scope.
- `control_request`: 1 per actor per 10 s. The owner sees at most 3 pending requests.
- Team listing in the client: 200 entries. Hydration is bounded to 8 concurrent
  requests with a 10 s timeout each.

Every Map/Set above is capped and evicted with its scope: presence, marks,
buckets, input mode and timers.

## Failure modes

- **Owner offline:** the ticket request returns `host_offline`. Team shows the
  computer as offline and keeps the entry, without retrying in a tight loop
  (backoff of 5 s to 60 s).
- **Concurrent audience edits:** optimistic concurrency is enforced in the
  `UPDATE ... WHERE revision = :expected`. The loser gets `conflict` and refetches.
  Scope creation is idempotent on `clientRequestId`, with `ON CONFLICT` on the binding.
- **Share racing tab close:** creation verifies the incarnation inside the
  transaction (existing `bindCollaboration`), so a closed tab fails with `conflict`.
- **Interleaved typing:** shared mode accepts bytes in arrival order with no
  merging. Typing indicators show who is active, and owner-only mode resolves
  conflicts. Documented as expected behavior.
- **Partial failure:** if the scope is created and the binding fails, the whole
  transaction rolls back. If the commit succeeds and the directory outbox publish
  is delayed, the entry appears late (the outbox retries), and access is never
  wider than the owner's state.
- **Membership service unreachable:** fail closed. New attaches are denied, and
  live input stops once the cached assertion expires.
- **Timeouts:** membership lookup takes 5 s (existing), attach 5 s (existing), and
  each desktop hydration fetch 10 s via `AbortSignal.timeout`.

## Integration wiring

`collaboration/wiring.ts` already builds the authority, verifier, terminal
dispatcher, event registry and control coordinator. The new pieces are wired
into those same objects:

- the presence registry is passed into `CollaborationTerminalEventRegistry`;
- the input-mode store goes beside `TerminalControlCoordinator`;
- the dispatcher handles the new actions;
- the team-terminal exception is passed to `scope-routes.ts` as an explicit
  `terminalAudience` service;
- the `/ws/terminal/events` publisher receives a typed `onCollaborationChanged`
  callback from the registry through dependency injection, with no `globalThis`.
- the Electron Terminal window session signs only platform `/api/collaboration/*`
  and `/api/organizations/*` requests with the account token (in the trusted
  core). Every terminal and computer request keeps its computer-scoped
  bearer, and the renderer never holds either token.

The shutdown order is: drain collaborator sockets, stop timers, then close the
DB pools that the collaboration owner created.

On the desktop, the main process owns collaboration sessions (existing
`createDesktopCollaborationApi`). The renderer calls typed IPC to list, open,
send and close streams. The Terminal window does not touch the main window's
connection store (2706 rule).

## Testing (TDD; named outcomes)

- Gateway unit tests and real-Postgres tests:
  - share and audience transactions, plus the rejection of every other standalone kind;
  - the per-frame role/mode table, with a direct socket proving that a viewer or
    paused editor causes no PTY write;
  - revoke and downgrade races: a frame sent after commit is rejected and the
    socket closes within 1 s;
  - membership expiry, caps and eviction, and the shutdown drain.
- Contract tests: new frames parse in both client parsers, and released parsers
  ignore unknown owner events.
- Desktop tests:
  - Team grouping by owner and computer, labels, the empty state, offline state
    and removal on revoke;
  - the read-only pane for viewers;
  - attribution marks rendered as xterm decorations;
  - the Share dialog's warning and role picker. These tests reuse existing
    `packages/ui` and shadcn controls.
- End-to-end: on the preview VPS described below, two accounts plus an outsider
  run J1 through J7.

## Preview plan

- Put the `preview-vps` + `preview-collaboration` labels on the top PR of the stack.
  `pr-<N>` is then provisioned under the collaboration-only owner from the
  protected `collaboration-e2e` environment (spec 535), running the stack's
  exact host bundle at `app.matrix-os.com/vm/pr-<N>`.
- Accounts: the collaboration owner (shares), member A (editor), member B
  (viewer), and an outsider in no shared org. Use test accounts only, never
  customer copies.
- Electron Desktop from the PR's CI artifact, with two separate profiles (two
  machines, or two `userData` directories), signed in as owner and member A.
- Script: share as editor with A and as viewer with B → both type into `claude`
  and prompt it → B is rejected → take control and hand back → downgrade A →
  revoke B (socket closes) → unshare.
- Because the platform needs no change, the production platform serves the
  preview. If a platform layer becomes necessary, the end-to-end preview waits
  until it is merged and deployed to the platform.
- Evidence (screenshots + recording per affected surface) is attached to the PR
  and posted to Slack `#tech`, never committed. Running Electron on a Mac needs
  a Mac session that is not the user's own windows, so Hamed or a delegated
  device must provide that session.

## Delivery (GitHub native stack, ENG-570)

| # | Layer | Main paths | Notes |
| --- | --- | --- | --- |
| 1 | Spec | `specs/2710-team-terminals/` | Docs only |
| 2 | Gateway authority | `packages/contracts/src/collaboration.ts`, `packages/gateway/src/collaboration/{scope-routes,terminal-adapter,terminal-dispatcher,canonical-terminal-bridge,direct-websocket}.ts`, new `team-terminal-audience.ts` | Exception, audience/roles, input modes, per-frame auth, rate limits, revocation |
| 3 | Gateway presence and attribution | new `terminal-presence.ts`, `terminal-events.ts`, terminal events publisher | Presence/attribution frames, owner feed, caps, shutdown drain |
| 4 | Desktop owner | `desktop/.../terminal-window/` (new `share/` folder), main-process IPC | Share dialog, shared badge, presence strip, take control, audience management |
| 5 | Desktop member + docs | `desktop/.../terminal-window/` (new `team/` folder), `packages/ui` direct stream, `docs/platform/user/team-terminals.md` | Team section, shared pane, read-only UX, who-typed-what in the pane header; user docs |
| 6 | Share a whole computer | gateway computer scope + desktop | Members see every tab on the computer and editors can open tabs; same roles, revocation and caps |

Public documentation ships as a separate `FinnaAI/matrix-os-site` PR under
`content/docs/` (a "Team terminals" guide: sharing, roles, take control,
stop sharing, and the full-shell warning), linked from layer 5 and ENG-570.

Every layer stays under 3000 additions and 50 files.
`TerminalWindowSidebar.tsx` (317 LOC) and `use-terminal-window.ts` (450 LOC)
get new code only through extracted modules, so they stay under 500 lines.

## Risks and open decisions

- **Constitution check:** a per-terminal `viewer/editor` role on an org-delegated
  personal resource. It reuses existing roles, and reviewers should confirm it
  fits Principles I and VII.
- **Full-shell blast radius:** an editor can read the owner's credentials. The
  recommended targets are team VMs. A sandboxed terminal profile (121 S07) is a
  possible later hardening and is not in this stack.
- **Share a whole computer** (members see every tab and editors can open
  tabs) is layer 6, approved 2026-11-24. Layers 2–5 group individually
  shared terminals under their computer; layer 6 adds the computer scope.
- **Web Desktop/Web Canvas N/A** was approved by Hamed on 2026-11-24 with the
  rationale under Surfaces. Follow-up: put the
  shared sidebar from `packages/ui` in the web Terminal app.

## Out of scope

Recording or replaying keystroke content; anonymous or cross-org access;
per-command restrictions; mobile surfaces; provisioning team VMs; platform-side
authorization.
