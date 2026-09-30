# Company drive in Files and Chat

## Outcome

An organization member finds their company drive from the Chat sidebar, browses
it like a project, and chooses the drive, a folder, or files as read-only Chat
context. The organization scope remains the authority. A local project directory
is not invented and copying another member's home is not required.

## Product experience

1. Chat's sidebar shows **Company drives** with one row per authorized organization
   drive, including a Join state for a pending organization grant. Opening a row
   selects that exact scope in Files. Existing personal projects remain separate.
2. Files uses one shared browser on Web Canvas, Web Desktop, Web Mobile and Electron
   Desktop: folders, breadcrumbs, search, name/modified ordering, file metadata,
   upload destination, storage meter, view/upload permissions and clear empty/error
   states. Browse state survives refresh and resets when the selected scope changes.
   Search in the first UI increment explicitly covers only the loaded listing;
   a server search must precede any claim of exhaustive drive search.
3. The context increment adds **Ask about this** and **Add to Chat** to a drive,
   folder and file. Chat's Add context picker and `@` picker show the same resources,
   organization labels and access states. Adding a chip does not send a message.
   Chips can be removed and keyboard navigation works in all three OS views.
4. A drive project row ultimately expands to Chats associated with that scope, plus
   Browse files and New Chat actions. A Chat association is owner-controlled
   Postgres metadata, not an organization sharing grant. Creating or importing a
   Chat leaves it private until its owner chooses a sharing action.

## Context behavior

Confirmed product behavior: the selected drive/folder authorizes
bounded live search/read for the current user request; individual files pin their
selected version. Selection never loads a 1 TB drive into a prompt or grants write
permission. The agent cites logical paths and versions for the files it actually
read. Binary or unsupported files get a truthful unavailable state; their bytes
are not decoded as text. Explicit attachment copies, if offered, require a separate
user action and explain that the copy remains in the destination Chat.

A reference carries immutable organization and scope IDs, optional logical folder
path/file ID, and a version where relevant. Renderer labels, local paths and
storage URLs are not authority. The receiving personal gateway resolves the
reference as the authenticated owner through the selected drive home. It must
check fresh organization membership, scope role, authority generation, Chat owner,
and allowed audience before admission, queued dispatch, retry, and each tool read.
Expired/revoked access fails closed. No reusable login or storage credential enters
the transcript, renderer, prompt, or tool result.

A private Chat may use a drive its owner can read. Sharing that Chat does not
implicitly share drive files. An org/shared Chat may use drive context only when
its allowed audience is within the drive audience; mixed/outside audiences cannot
receive those excerpts or search results. Original transcript archives, internal
context and thinking remain private under Spec 541.

## Runtime work required before enabling context actions

- A headless, read-only delegation between the requesting owner runtime and drive
  home, using current scope authorization rather than platform-stored file content.
- Bounded folder/path search and exact immutable-version text reads from the drive
  home. Hash/size verification, strict UTF-8 detection, unsupported binary handling,
  bounded response bytes, 10-second API/30-second object deadlines, and revalidation
  after remote I/O. No user URL fetch or arbitrary local path.
- Typed canonical references plus persisted owner Chat drive association and tool
  attribution. Related database writes are transactional; scope identity upserts
  use ON CONFLICT, and version updates enforce their observed revision in SQL.
- Per-run read-only tools or resolved excerpts supported by the chosen harness.
  If the harness lacks this route, disable context with a useful explanation.
  A plain `@label` or a download URL does not count as resolved context.
- Both queued and immediate turns, account/runtime changes, sharing transitions,
  revocation, and interruption must preserve these boundaries.

## Auth matrix

The browser increment retains existing discovery and signed scope sessions. The
source API increment adds these endpoints; none is public:

| Route | Authentication and authorization | Data and limits |
| --- | --- | --- |
| `POST /api/collaboration/scopes/:scopeId/drive/context/search` | Signed scope request; exact organization/folder scope; fresh member, role, epoch and authority checks before return | Read-only operation with a signed, bounded request body; 50 rows maximum; literal metadata path search with a 5 second SQL deadline; private, no-store |
| `GET /api/collaboration/scopes/:scopeId/drive/files/:fileId/context` | Signed scope request; exact organization file; fresh authorization and live-file checks after I/O | Current/pinned immutable version; 4 MiB verified source, 32 KiB UTF-8 excerpt; four concurrent reads; private, no-store |
| `POST /internal/collaboration/drive-context/connections` | Enrolled runtime credential; actor derived from enrollment owner; folder ticket fixed to direct-session purpose and four actions | Strict bounded JSON; no client actor override; no file content stored by platform |
| `POST /internal/collaboration/drive-context/relay/api/collaboration/direct-sessions` | Enrolled runtime plus owner-bound ticket, possession proof and exact scope/runtime/origin | Creates an ephemeral proof-bound session; no general relay or drive write access |
| `POST /internal/collaboration/drive-context/relay/api/collaboration/scopes/:scopeId/drive/context/search` | Enrolled runtime and signed owner session; source home checks current membership/authority | Original signed body bytes retained; 96 KiB request cap; bounded source metadata response |
| `GET /internal/collaboration/drive-context/relay/api/collaboration/scopes/:scopeId/drive/files/:fileId/context` | Enrolled runtime and signed owner session; source home checks exact file, version and authority | 128 KiB response cap at owner client; no enrollment token forwarded to home |
| `DELETE /internal/collaboration/drive-context/relay/api/collaboration/direct-sessions/:sessionId` | Enrolled runtime and signed exact session | Cleanup after every operation; three second cleanup deadline; source TTL covers lost acknowledgments |


The source endpoints add no writes, copied objects or database ownership. Failed
reads cancel their bodies. Renderer and Chat admission remain separate
from these read-only transport APIs; context controls stay unavailable until delegation, Chat
admission, queue/retry checks and harness wiring pass together.

## Delivery and evidence

- [ ] Shared browser and exact-scope Chat sidebar shortcut PR; current-head review,
      full CI, synthetic visual evidence and a separate public site docs PR.
- [x] Source search/read contract, auth matrix and failing boundary tests (PR #2084).
- [x] Owner-runtime delegation with signed cross-runtime integration, long UTF-8
      folder searches, membership revocation, caps and shutdown cancellation tests.
- [ ] Deployed runtime delegation and live acceptance.
- [ ] Canonical association, run tools/excerpts and queue/retry revalidation.
- [ ] Shared Add context/mention/File actions, scope-associated Chat grouping,
      empty/disabled/error states and keyboard parity.
- [ ] Hamedmp/nimanaderi live drive acceptance using synthetic files: both members
      read the same version; outsider, removed member and stale authority fail.
- [ ] Exact compatible Web/host/Electron artifacts before Authority rollout.

Native Mobile: drive transfer is already excluded by Spec 530. When drive context
is made available there, it must use the same business semantics and typed API;
no unsupported native picker is implied by the Web Mobile browser increment.

## Delegation runtime wiring

Platform composition registers a narrow enrolled-runtime endpoint beside existing
collaboration delegation, reusing the current runtime enrollment verifier, ticket
issuer and transparent home relay. The requesting gateway client is bound to the
configured owner, runtime and platform origin; each operation creates a fresh
proof key, exchanges a folder ticket, sends one signed search/read, then closes
that session. The platform never forwards enrollment credentials to a home.

The client permits four concurrent operations, bounds JSON responses to 128 KiB,
uses ten second HTTP deadlines and a sixty second operation deadline, rejects
redirects, and aborts outstanding work when closed. Unknown or malformed responses
become a safe unavailable error. Chat composition must inject this dependency and
close it during shutdown before context controls become available. The transport
increment alone does not enable Chat context or persist a Chat association.

## Canonical Chat runtime increment

The gateway resolves the drive client during registration, before constructing the
provider catalog. The catalog advertises `organization_drive` only for an available
Claude Code harness when that read dependency exists. Other harnesses show the
capability as unavailable until their own scoped run tools are implemented. This
is an explicit temporary harness limitation, shared by every OS view.

Typed message references persist only organization/scope identity, folder paths,
and selected file versions. They are authorized before turn or queue admission,
before queued dispatch/retry, and again around every tool read. No drive content
is copied into admission context. The model selects a reference index; it cannot
choose an actor, run, organization or arbitrary source URL.

| Route | Authentication and authorization | Data and limits |
| --- | --- | --- |
| `POST /api/chat-drive-context/search` | Exact per-run Matrix MCP capability with the drive grant; active personal owner-bound run; live source authority before and after I/O | Strict JSON, 4 KiB pre-buffer body limit, admitted reference index, 50 rows, private/no-store |
| `POST /api/chat-drive-context/read` | Same scoped capability and active-run checks; pinned file or file within the admitted drive/folder | Strict JSON, 4 KiB request, 128 KiB verified source response; no write tools |

Ordinary machine or user bearer tokens do not grant these model endpoints. The
Claude launcher exposes only the two fixed read tools alongside the existing
scoped MCP surface, and revokes the run capability during cleanup. Gateway
shutdown cancels the source client before its capability registry is closed.

Until an audience policy can preserve provenance transitively, sharing a Chat
containing drive material is disabled. The check is repeated under the existing
Chat row lock, so a previously issued share confirmation cannot bypass it.
Project resource staging checks the same restriction, and final project publication
locks each inherited Chat and rechecks drive material in the publication transaction.
Mentioning such a Chat as context in another Chat is also disabled, including
queued/retried referenced history. Personal stored Chat history stays readable.
This increment does not claim organization sharing of drive excerpts.

Large-file extraction plan: new authorization, tools, production configuration
and audience checks live in focused modules. `server.ts` supplies dependencies and
shutdown hooks only. `orchestrator.ts` receives one retry capability requirement;
its existing admission and queue helpers continue to own the extracted workflows.

Evidence requires real owner-Postgres admission/run lookup, queue and retry
revocation checks, scoped HTTP denial/revocation, exact MCP tool advertisement,
production dependency failure and shutdown checks, and locked share conversion.
Public docs must describe the harness and sharing limitation before UI actions
ship. Persisted drive-to-Chat association and visible context controls follow in
separate increments; this runtime PR alone does not enable them.


## Drive projects and composer controls

- Persist the first admitted drive as a private Chat organization entry in owner Postgres. Immediate and queued admission write it inside their existing Chat lock/transaction. `ON CONFLICT DO NOTHING` preserves an explicit prior association. A null association is an intentional tombstone and never silently auto-reassigned.
- The Chat sidebar expands a company drive into Browse files, New Chat and loaded associated private Chats. It distinguishes initial association loading/error from an empty group. Same-client refreshes retain previously loaded rows filtered to current Chat IDs, including safe refresh failures. Identity changes, hidden panes, and stale asynchronous completions clear or ignore prior results. A drive entry is not a filesystem project and grants no Chat audience rights.
- Add context and `@` offer the authorized drive, a logical folder, or a version-pinned file. Limit each message to three distinct drive references, retaining complete authority paths while bounding labels. Only current catalog capability enables submission; unsupported routes preserve the draft and show how to choose Claude Code.
- Files exposes Ask in Chat for the current drive/folder and Add to Chat for an entry. Both open an editable new private draft without sending. Existing Chat context is added through its composer. Web draft intent is one identity-bound request with a ten-minute validity check and one-shot consumption. Web Mobile uses a focus signal and leaves persisted desktop layout unchanged. Electron uses one credential/runtime-bound, expiring intent targeted to the active Chat tab. Files does not require a Work provider; only that tab consumes the intent into an editable draft. A navigation to another conversation prevents consumption. Drafts remain bound to credential/runtime identity while the client becomes available or is refreshed; replacing credentials hides the prior draft immediately.
- Picker listings are lazy, bounded metadata previews, not exhaustive search or prompt content. Once admitted, run tools search the live authorized source and read current files as needed. A selected file stays pinned to its recorded version.

| Route | Authentication and authorization | Limits |
| --- | --- | --- |
| `POST /api/chat-drive-projects/lookup` | Authenticated personal principal; owned active private Chats only; drive UI shows only current authorized drive discovery | Strict JSON, 16 KiB pre-buffer body limit, 100 Chat IDs, 5s SQL deadline, private/no-store |
| `PATCH /api/chats/:chatId/drive-project` | Same owned private Chat, fresh drive authorization, then repeat Chat privacy check under row lock | Strict path/query/body, 4 KiB body limit, revision CAS and idempotent request ID; all Chat/association reads and revision/outbox writes share one short transaction; 5s SQL/lock deadline |

An association remains safe private metadata when membership is revoked; source discovery hides inaccessible drives and every read still checks current authority. Unknown failures use generic errors. No new pool or local persistence format is introduced. Schema bootstrap is additive and serialized by an advisory transaction lock. Source-only authorization checks the configured owner and live drive membership without reading Chat data or acquiring its database connection. That remote I/O has a sixty-second bound and the shared source client permits four concurrent operations. After authorization, all Chat/association reads and writes occur in one short transaction with a Chat row lock and current owner/privacy/revision checks. No database connection is held over remote authorization.

Extraction plan for existing large composition modules: `ChatApp.tsx` wires the shared navigation and composer only; Files draft state and context controls live in focused modules. `SharedChatComposer.tsx` wires a focused surface adapter and derives capability from the catalog. `queue-repository.ts` replaces its context-part filter with `context-reference-parts.ts` and calls `drive-project-database.ts` inside the existing claim transaction; it adds no inline drive workflow. Mobile shell adds one extracted focus hook.

Public documentation deliverable: update the private site drive and Chat context docs with root/folder/file selection, privacy, editable Files draft handoff, supported harnesses, bounds and release availability. Validate Web Canvas, Web Desktop and Electron Desktop; Web Mobile adapts only navigation. Native Mobile has no company drive capability in this increment.
