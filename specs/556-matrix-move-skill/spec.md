# Move a chat or project to Matrix

## Outcome

`matrix-move` composes the existing private transcript importer, file transfer,
folder-project registration, and Chat/project assignment into a portable skill.
It supports local Codex/Claude Code and accessible cloud workspace artifacts.
Source work remains intact. Completeness is verified per selected item.

The canonical skill is `skills/matrix/move/`; the external plugin includes a
self-contained copy at `plugins/matrix-os/skills/matrix-move/`. The repository
skill points to the canonical source. Runtime skill sync discovers it; remote
Agent/Hermes installers include it. Keep the plugin copy identical when changing
instructions, references, scripts, or UI metadata.

## Existing authority and persistence

| Capability | Existing authority | Storage |
| --- | --- | --- |
| Original transcript import | Authenticated runtime personal owner through `/api/chats/imports/local` | Owner Postgres canonical Chats plus private original objects |
| Workspace upload/run | Authenticated selected CLI profile or MCP runtime slot | Owner's Matrix home |
| Register folder project | Authenticated `POST /api/projects`, or product UI | Existing project registry; path admitted by project manager |
| Assign Chat to project | Authenticated `PATCH /api/chats/:chatId/project`, revision guarded | Existing canonical Chat service and collaboration authority |

No endpoint, auth path, or persistent database is added. Use the existing API
validation, body limits, idempotency, transactions, and owner resolution. The
MCP server's read-only Chat tools do not become import/mutation tools. The CLI
has no project-import command, so skill organization uses product controls when
an established authenticated client transport is unavailable.

The local snapshot helper has no network access. It captures at most 20,000
entries, 64 directory levels and 512 MiB of regular source files. It skips
symlinks, common credentials, generated content, and ignored Git files; it never
reads global agent stores. Files preserve executable permission and get SHA-256
manifest entries. Temporary output is private and split into bounded 8 MiB
upload parts. The skill owns exact-directory cleanup after completion/cancel,
or within 24 hours for abandoned previews. It requires remote archive and
destination-file verification, exclusive destinations, and explicit partial
state reporting on failures.

## Acceptance

- Current-chat selection uses the actual source identity. Project inventory
  cannot infer membership from mtime, title, or a shared directory alone.
- Active current-chat capture ends at the invoking user turn; earlier source
  bytes remain unchanged and transfer diagnostics stay outside that snapshot.
- Imported Chats verify canonical read-back and original archives; source
  snapshots are reused on retries. Unknown/missing content remains explicit.
- Project files verify against their manifest before registration. Imported
  Chats appear in the chosen personal project through existing authority.
- A continuation brief and source-to-destination receipt identify remaining
  work. Transfers never silently start inference, share, or delete source work.
- Cloud summaries are labeled partial handoffs. Unsupported exports remain
  private files until a validated adapter exists; no fabricated transcript.
- Tests exercise Git dirty/untracked/ignored data, secret/symlink exclusion,
  archive reconstruction/checksums, non-Git folders, briefs, and collisions.
- Canonical publication accepts an original ending in tool activity without
  storing a blank `lastMessagePreview`. A synthetic regression verifies history,
  Chat-list read-back, and idempotent publication; private operator transcripts
  are never committed as fixtures.

## Deferred work

Full Git object/index/worktree migration remains a separately scoped transfer.
Cloud providers without a supported transcript export need an adapter before
full native history import. A skill cannot remove either limitation.

Private resource links need a common authenticated locator containing runtime
identity plus project/Chat identity. A future HTTPS router should preserve the
locator through sign-in and computer selection and offer Web Desktop/Web Canvas
or Electron Desktop. Electron requires validated resource deep-link dispatch
and cold-start queuing; its current auth callback is not a resource locator.
Links must grant no access and must not publish private content. Validate owner
access, wrong-runtime rejection, missing resources, and surface parity before
the skill emits such URLs. Native/Web Mobile behavior needs explicit validation
or a documented platform limitation.

## Delivery

- Implementation and instructions through a worktree PR, focused checks and
  current-head review. No live private customer transfer is required to create
  or test this skill; use synthetic source data.
- Separate `FinnaAI/matrix-os-site` documentation PR explaining invocation,
  private imports, file exclusions, cloud limits, and link limitations.
- Manual release acceptance: select a synthetic source, upload to one test
  runtime, verify file hashes and canonical history, register a private project,
  attach Chats, and confirm source remains intact in Web Canvas, Web Desktop,
  and Electron Desktop using their shared project/Chat semantics.
