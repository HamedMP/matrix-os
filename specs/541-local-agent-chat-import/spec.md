# Import local Codex and Claude Code conversations

## Goal

Import owner-selected Codex and Claude Code sessions from Linux and macOS into
private canonical Matrix Chats, using the CLI, the Matrix skill, or Settings.
Preserve original exports and reconstruct readable history. Sharing remains a
separate owner choice. This extends the text-only importer in Spec 540.

## Evidence

Observed Linux Codex sessions contain one session_meta, ordered response_item
records, duplicate event_msg notifications, turn_context and compaction records.
Assistant messages have commentary and final_answer phases. Tool requests and
results link by call ID. Some records are encrypted and cannot be rendered.

Observed Claude Code project JSONL records contain UUIDs, parent UUIDs, session
IDs, timestamps and cwd. Message content is a string or text/thinking/tool_use/
tool_result blocks. Attachments, compaction, snapshots, queued operations and
titles are separate records. Subagent files sit beneath a session directory.

These are bounded observations, not an exhaustive format contract. The September 30 macOS investigation confirms multiple Codex generations,
mirrored event/model messages, Claude assistant fragments, nested PNG/PDF
attachments, subagent files and external persisted outputs. Claude compaction
and user-created forks remain unconfirmed in that Mac corpus. The Linux audit confirms system `compact_boundary` records with
`compactMetadata` and separate user records with `isCompactSummary: true`. Fixtures use sanitized structure and valid
synthetic identifiers; they never include operator or customer private text.

## Fidelity and privacy

- Preserve selected original exports byte for byte in private owner storage,
  verified by raw size and SHA-256, with harness/session/import provenance.
  Unknown and encrypted records stay available in that archive.
- Preserve user text, assistant commentary/finals, tool calls/results,
  timestamps, order and turn relationships. Historical activities never execute
  tools or create live approvals. Long content is chunked or archived without
  silent truncation.
- Preserve embedded attachments as owner assets. External references require
  explicit scoped selection and availability checks. Do not automatically
  follow arbitrary paths or URLs. Identify unavailable assets in preview and
  imported history.
- Reconcile duplicate records, parent-linked branches and related subagents.
  Never concatenate unrelated branches as one conversation.
- Preview distinguishes readable, archived, missing, opaque and unsupported
  content. Never claim completeness from projected message counts alone.
- Namespace source identity by harness. Retrying is idempotent. Upgrading an
  existing text-only import preserves subsequent owner messages and grants;
  do not silently replace it or create duplicate Chats.
- Authenticated principal owns archive and Chat. Repository/cwd evidence can
  suggest a project; it cannot authorize attachment or sharing. Exclude global
  history, credentials and unrelated sessions. Source files remain unchanged.
  Operator-machine transcript content must not become customer test data.

## Implementation constraints

One shared parser and transport serves Web Canvas, Web Desktop, Electron
Desktop and CLI. Native Mobile file selection remains explicitly deferred.
Large original archives use bounded, resumable parts in the primary object
store and owner-scoped keys, not organization drives by default.

Specify exact route auth matrix and body limits before adding endpoints.
Mutating routes use bodyLimit, strict Zod boundary schemas, timeouts and safe
errors. Derive owner from the request principal. Publication is one transaction.
Staging has count/byte/TTL bounds and recurring cleanup. Verify archive and
projected content before making Chat visible. Failed jobs stay invisible.

## Acceptance and delivery

1. Sanitized Linux and Mac fixtures cover both harnesses, tools, attachments,
   long content, duplicates, branches, subagents, compaction and resumed sessions.
2. Content and relationships match canonical Chat read-back and shared visual
   presentation. Original archive downloads with the exact source hash/size.
3. Cross-owner access, edited sources, malformed data, retries and interruptions
   cannot expose partial/duplicate Chats or execute imported activities.
4. Preview and final reports identify unavailable/unreadable content. Verify
   every selected session independently. Imports remain private until chosen
   project attachment or sharing through existing collaboration authority.
5. Ship reviewed worktree PRs with focused regressions, current-head Greptile
   5/5, CI, packaged CLI and synthetic live verification. Update the public
   guide through a separate FinnaAI/matrix-os-site PR.


## Reconstruction acceptance cases

| Case | Readable prose | Tool calls/results | Media | Other retained activity |
| --- | --- | --- | --- | --- |
| Codex mirrored user/progress/final | 3 messages | 1/1 | 0 | Two mirrored pairs collapsed |
| Legacy unwrapped Codex | 2 messages | 1/1 | 0 | Header and state archived |
| Codex image and missing local mirror | 1 message | 1/1 | 2 | Missing reference reported, no third attachment |
| Codex child/compaction/inter-agent | 0 new parent messages | 0/0 | 0 | Compaction and inter-agent entry, inherited context separate |
| Claude fragmented assistant | 1 message | 1/1 | 0 | Thinking retained separately, tool result not human input |
| Claude tool PNG | 0 prose messages | 1/1 | 1 | Media linked to result |
| Claude tool PDF | 0 prose messages | 1/1 | 1 | Result text retained |
| Claude subagent | 2 child messages, 0 parent | 0/0 | 0 | Child identity distinct |

Record identity, source file, stable byte boundary, byte offset, source order,
ordinal, timestamps and parser version persist independently of presentation.
Codex event mirrors require matching turn/proximity/content when IDs differ.
Never deduplicate repeated prose globally. Claude record UUID identifies an
entry; assistant message ID groups compatible fragments. Parent siblings alone
do not prove forks. Multiple distinct results with one call ID are an ordered
collection. Unknown shapes and malformed middle lines remain in the original
archive with a reported issue; partial final lines remain retryable. Archive
completeness means the captured source bytes, not recovery of deleted or
unsaved history. Original files are never normalized or rewritten.

## Route authorization and limits

All routes below require the gateway's authenticated personal owner principal.
No route is public. No organization membership, shared Chat grant, path, request
owner field or provider session binding grants access to import jobs or archives.
Existing `/api/chats/imports/codex` compatibility remains available while the
new protocol is independently versioned. Harness is part of source identity.

| Implemented route | Method | Authority | Request body limit |
| --- | --- | --- | --- |
| `/api/chats/imports/local` | POST | Personal runtime owner; job/archive admission | 8 KiB |
| `/api/chats/imports/local/:jobId` | GET | Exact job owner | None |
| `/api/chats/imports/local/:jobId/parts` | POST | Exact job owner; at most eight part numbers | 8 KiB |
| `/api/chats/imports/local/:jobId/parts/ack` | POST | Exact job owner; acknowledged size and receipt | 8 KiB |
| `/api/chats/imports/local/:jobId/complete` | POST | Exact job owner; immutable archive completion, queue verification | 8 KiB |
| `/api/chats/imports/local/:jobId` | DELETE | Exact job owner; cancel idle unfinished job only | 8 KiB |
| `/api/chats/imports/local/:jobId/archive` | GET | Personal source owner, independently of Chat sharing | None |
| `/api/chats/:chatId/imports/assets/:assetId/content` | GET | Personal runtime owner; live owned Chat and exact visible asset occurrence | None |

Strict Zod schemas validate IDs, harness, hashes, integer sizes, offsets and
part numbers. Reject owner IDs and caller-selected object keys. Admission has
8 open jobs per owner, 20 GiB per original file and 24-hour staging expiry.
Multipart transfer uses bounded 64 MiB parts, expiring presigned access,
checksums, explicit abort and resumable state. Cap progress and issues in RAM;
store durable metadata in owner Postgres. Verification streams object bytes
with an overall deadline and bounded per-record memory. Over-limit projection
fails explicitly while keeping the selected source recoverable; it never
silently trims content. Completed archives persist until owner deletion.
Recurring expiry aborts multipart work and deletes only exact staged keys;
explicit recovery handles object-store/database partial failures.

## Runtime wiring and publication

Gateway composition injects the existing primary R2 client and owner Chat
repository. Import services do not destroy shared pools or object-store clients.
Source bytes are uploaded directly from CLI/browser/Electron transport to an
owner-private staging namespace. A verified original archive is required before
Chat publication. The server reconstructs readable history directly from the verified source;
client message projections and counts are never publication authority. One Postgres transaction publishes Chat, membership, completed
historical turns, rich activity references, provenance and outbox events.
Historical activity never creates a live run, provider session or tool approval.

Large prose and tool payloads retain full bytes in private content assets;
canonical parts provide bounded readable segments and explicit download links.
Embedded attachments are decoded and content-addressed with source occurrences
retained. Local/remote references are reported without automatic path/URL reads.
Selecting an external file is a separate explicit import choice. Thinking,
injected instructions and opaque records remain separately identified and are
not rendered as human prompts. Subagents create linked private child histories.

Re-import identity is owner + harness + source session + agent/branch identity.
Movement into an archive directory does not create a duplicate. Incremental
snapshots identify overlap by source records and boundaries, preserving repeated
human prompts. An existing text-only import requires an explicit previewed
upgrade, revision check and transaction; preserve IDs, subsequent owner content,
project references and grants. If source ancestry is ambiguous, preserve separate
candidates and require selection rather than merging them.

## Delivery sequence

1. Versioned lossless reader and sanitized Linux/Mac acceptance fixtures.
2. Owner-private archive multipart API and durable jobs with actual PostgreSQL
   transaction, authorization, expiry and checksum integration coverage.
3. Canonical reconstruction and shared Chat rendering, including multiple tool
   results, long text/assets, missing dependencies and historical provenance.
4. Shared Settings selection/preview/progress and CLI discovery/import/upgrade;
   root overrides, archived sessions and subagents discovered independently of
   indexes. Skills require dry-run inventory and explicit session selection.
5. Public guide PR, packaged CLI/Electron verification and synthetic live tests;
   Ash's approved source repair/upgrade only after reviewed artifact deployment.


### Local environment versions

September 30 Linux audit: Codex CLI 0.159.2 and Claude Code 2.1.285; both state
root overrides unset, with no Codex archived transcripts found in the default
archive directory. The Mac audit used Codex 0.153.2 and Claude 2.1.284 and found
older transcript generations. Stored record shape remains authoritative over
the currently installed executable version. Linux compaction confirmation used
bounded scans and emitted structural metadata only, never session prose.

## Durable transfer recovery

Allocation commits an exact-key job intent before creating a multipart upload.
A receipt and lease bind subsequent operations to that job. A bounded exact-key
listing recovers storage allocation that succeeded before a gateway crash; it
does not enumerate unrelated owner objects. Parts persist in owner Postgres.
Sealing is committed before object-store completion; after a lost completion
response, coarse object existence permits checksum verification of the original
rather than overwriting it. A competing worker must acquire a fresh durable
lease. Recovery claims one job at a time so queued claims cannot expire during
other network operations. Storage calls remain bounded independently of leases.

Cancellation is allowed for idle unfinished uploads, not an active verification,
sealing or publication. Terminal jobs retain exact-key cleanup intent until
abort/delete succeeds. No worker destroys shared clients or database pools.
Runtime composition owns recurring recovery/expiry, cancels workers, and awaits
shutdown before closing their dependencies. A completed archive is deleted by
the source owner independently of shared Chat access; Chat deletion must also
retain durable asset/archive cleanup until verified.

The initial foundation PR supplies readers, reconstruction fixtures, archive
verification, durable transfer jobs and authenticated R2 recovery capabilities.
It does not register the Chat import routes or replace existing UI.
Publication, rendering, clients and final runtime wiring ship in subsequent
reviewed PRs before claiming the new importer is available.

### Implemented internal recovery broker authority

| Route beneath `/internal/containers/:handle/sync` | Method | Authority | Body limit |
| --- | --- | --- | --- |
| `/multipart/list` | POST | Existing per-runtime broker credential; database-resolved active machine owner/runtime; exact allowed owner key | 64 KiB |
| `/object/head` | POST | Same broker credential and owner/runtime key boundary | 64 KiB |

Neither route is public. Scoped credentials include machine ID/runtime slot and
are validated against the active machine and token epoch. Legacy primary-runtime
credentials retain the existing owner-resolution path. Request owner fields do
not grant authority. Exact-key enumeration returns at most ten upload receipts;
truncated provider enumeration fails closed. HEAD returns a coarse `exists`
boolean only. Missing upload abort is idempotent, while access/transport failures
remain errors. No credential or raw object-store error reaches clients.

### Reconstruction and receipt repair safeguards

Different-ID Codex mirrors require recorded turn evidence and adjacency or the
same explicit turn. Turn/context boundaries and assistant/tool activity close
unpaired human-input mirror candidates. Ambiguous different-ID repeated prompts
remain separate rather than disappearing. Each Claude content block retains its
block index and is emitted in recorded order; shared response identity does not
move prose across tools or thinking. Every readable record must establish its
session and agent identity. Oversized records fail projection explicitly instead
of reporting a complete readable import with skipped content. Raw source files
remain unchanged and the staged object stays private.

A definitive invalid-part receipt error restores `uploading` and clears stale
acknowledgments in one lease-guarded transaction. Clients can re-upload and
acknowledge current parts before resealing. Transport/unknown errors remain
`sealing` for original-object existence recovery; they do not overwrite an
archive whose completion response was lost. The broker projects a generic
`receipt_mismatch` code, never a raw object-store error.

## Canonical publication increment

The publication increment registers the authenticated routes above and a single
runtime worker. Gateway shutdown aborts and drains this worker before shared DB
and primary R2 resources close. A synthetic integration test exercises admission,
part signing/acknowledgment, archive sealing, worker verification, canonical Chat
read-back, full-text download, cross-owner denial and injected resource lifetime.

Verification publishes only after exact raw SHA-256, length and source/agent
identity succeed. The transaction commits personal Chat membership, historical
turns, messages, asset links and outbox together. Assistant-only history is
readable without fabricating a human message, turn or executable run. Projection
is limited to 100,000 bounded canonical rows and 64 MiB per decoded asset; an
excess fails explicitly. Original JSONL is unchanged. Long text and tool payloads
use full-content assets with bounded UI previews. Same-origin authenticated asset
streaming is compatible with packaged Electron CSP. Never pass arbitrary source
paths or URLs into the asset transport.

Historical presentation preserves source sequence, all distinct results per
call, later call/result linkage, and adjacent compatible Claude response
fragments. Tool activity is an ordering boundary. Incomplete calls never acquire
live progress or approval actions. The source owner alone can download the raw
archive. Failed, cancelled and expired staging is swept repeatedly using durable
exact-key cleanup intent; deleting a published Chat schedules its private archive
and assets for cleanup.

This increment does not expose a new Settings/CLI import action. Incremental
overlapping snapshots, explicit upgrades of existing text-only Chats, external
file selection, parent/child Chat linking, shared-recipient asset authorization,
and Native Mobile historical rendering remain subsequent delivery gates. Do not
claim those capabilities from the parser fixtures or an isolated API success.
A compatible Electron/Desktop renderer must ship before customer imports emit
new canonical part types. Imported source context and thinking remain private
archive material and never become shared human messages.
