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

Default design pending product feedback: the selected drive/folder authorizes
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

The implemented browser increment adds no network endpoints. Existing discovery
uses authenticated platform identity; listing, grant activation, upload, commit,
and download retain direct proof-of-possession scope sessions and fresh home-side
organization authority. Electron transfers retain trusted-main IPC. Proposed
context endpoints remain unavailable until their concrete auth schemas, wiring,
limits, rejection tests and shutdown path land together in the context increment.

## Delivery and evidence

- [ ] Shared browser and exact-scope Chat sidebar shortcut PR; current-head review,
      full CI, synthetic visual evidence and a separate public site docs PR.
- [ ] Context delegation/search/read contract, auth matrix and failing boundary tests.
- [ ] Canonical association, run tools/excerpts and queue/retry revalidation.
- [ ] Shared Add context/mention/File actions, scope-associated Chat grouping,
      empty/disabled/error states and keyboard parity.
- [ ] Hamedmp/nimanaderi live drive acceptance using synthetic files: both members
      read the same version; outsider, removed member and stale authority fail.
- [ ] Exact compatible Web/host/Electron artifacts before Authority rollout.

Native Mobile: drive transfer is already excluded by Spec 530. When drive context
is made available there, it must use the same business semantics and typed API;
no unsupported native picker is implied by the Web Mobile browser increment.
