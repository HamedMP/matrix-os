# Organization drive

## Goal

Members of one verified Clerk organization can use one shared file drive from
their own Matrix computers. File content is stored in R2; file metadata,
versions and quota accounting are stored in owner-controlled
Postgres. Personal files and Chats remain private until explicitly moved or
shared. A drive is identified by immutable organization ID, never a mutable
handle or a member's login.

## Product behavior

- Files shows each organization drive to current members on Web Canvas, Web
  Desktop, Web Mobile and Electron Desktop. A member can list, upload and download files.
  Listings are paged by logical path so drives with more than one page remain usable.
  The shared browser derives virtual folders, breadcrumbs, name/modified ordering,
  loaded-file search, visible metadata and upload destination from those pages.
  Search states its loaded-list scope when more pages remain; a view retains at
  most 20 pages. Chat shows company drive shortcuts which select the exact
  authorized scope in Files; it does not create a local project or share a Chat.
  Upload paths can contain virtual folder segments. The owner enables a drive
  from an existing organization-shared folder scope and grants Contributor
  access to the organization; each member activates that grant. Membership
  continues to come from the existing Clerk organization authority.
- A file in the drive has one logical path and immutable content versions.
  Writers supply the version they observed. Concurrent writes either create
  distinct conflict versions or return a conflict; they never silently replace
  another member's work.
- A 1 TB default quota applies to committed bytes plus in-flight reservations.
  R2 bucket capacity is not the quota. Usage and reservation updates must be
  atomic across concurrent members.
- Initial files up to 100 MiB transfer directly between the client and R2
  through bounded, short-lived URLs. A completed object is not visible until Matrix
  verifies its size and checksum, publishes the verified bytes under a separate
  key that has no client PUT URL, and commits its metadata. Abandoned uploads
  release their quota; the recurring sweep deletes staging objects only after
  every issued PUT URL for that reservation has expired.
- Revocation blocks new reads, listings, uploads, commits and URL issuance.
  Already issued short-lived URLs expire; the UI must never cache them beyond
  expiry. Credentials stay in the storage broker, not on member computers.
- Private Chat messages remain in their current owner database. An explicit
  Chat share uses the existing collaboration authority. A transcript stored in
  the drive is a file, not a canonical Matrix Chat.

## Storage and authority

For the first rollout, one organization member's VPS is the selected drive authority.
It holds the organization drive's Postgres metadata as delegated custody while
the platform does not yet provision organization computers. The drive's stable
organization ID, object IDs and authority generation must survive a later move
to a dedicated organization computer; the member's personal handle and home paths are
never member-facing drive IDs.

The drive authority is one selected home/runtime at a time.
The platform holds Clerk membership projection, runtime directory, policy and
metering only. It must not become the durable store for file paths or content.
R2 objects use opaque version identifiers under an organization segment in
the selected runtime's broker-scoped prefix. The serving home authorizes every metadata operation with
fresh organization membership and a drive role; the platform brokers scoped R2
operations without exposing long-lived credentials.

## Acceptance

1. Two distinct member accounts on two VPSes list and download the same file;
   an upload from either appears on the other without copying home directories.
2. An outsider and a removed member cannot list, presign, complete or download;
   revoked sessions and old authority generations fail.
3. Concurrent uploads at the quota boundary cannot exceed 1 TB, and identical
   request IDs are idempotent.
4. An interrupted upload can be retried with the same request ID without a
   duplicate visible file. Hash mismatch and abandoned staging objects fail
   closed and release capacity.
5. Owner-home restart retains committed file metadata and immutable versions.
6. Web Canvas, Web Desktop, Web Mobile and Electron Desktop expose the same discovery,
   grant activation, listing, upload, download, quota, loading and error states.
7. On Electron Desktop, a changed account, runtime or credential generation
   aborts active R2 I/O and prevents subsequent transfer steps. Local downloads appear only after the received
   bytes match the authorized version's length and SHA-256 digest.

## Electron Desktop transfer

The packaged Electron Desktop Files renderer has a `file://` origin, so it
cannot send browser CORS requests to R2 presigned URLs. It discovers and
manages drives with the same direct collaboration client and shared paging
logic as the Web views. The renderer sends only validated scope, organization,
file and runtime identifiers through IPC. The trusted main process independently
authenticates to the scope authority, obtains presigned transfer URLs and
uses native file dialogs. It reads uploads from user-selected regular files up
to 100 MiB and writes verified downloads through a temporary file in the
selected destination directory. It never accepts a renderer-supplied URL or
local path, and it does not send a long-lived R2 credential to the renderer.

The native bridge validates HTTPS and public DNS addresses before fetching a
presigned URL, rejects redirects, checks account and runtime generation around
the transfer, and closes its direct session after each operation. Node's fetch
resolves DNS independently after validation; DNS rebinding remains a residual
risk until the transport pins the validated address or the platform supplies
an exact trusted storage endpoint allowlist. Native Mobile is outside this
initial transfer surface.

The R2 bucket used by Web clients needs exact-origin CORS entries for the
deployed Matrix web origin, with GET and PUT access and only the required
request headers. No wildcard origin or long-lived credential is sent to the
browser. The default quota is enforced by Matrix metadata, not by the bucket.

## Separate follow-on

Importing an 8–11 GiB archive or folder into a project requires an additional
staging-to-project workflow, archive extraction limits, path validation and
progress reporting. Multipart transfer, durable resumability, empty folders,
rename/delete and a dedicated organization computer are follow-on work.
That move also needs a documented Postgres plus R2 restore and authority
generation change before the selected member VPS can be retired as custodian.
