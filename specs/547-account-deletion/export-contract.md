# ENG-287 account export contract

Approved implementation scope: preserve backup metadata, distinguish completed empty inventory from unavailable reads, add the proven portable platform groups, and provide bounded continuation. No deletion, retention, fresh-snapshot creation, provider migration or broader ownership audit changes.

## Auth and wiring

| Route | Auth | Operation |
| --- | --- | --- |
| GET /account/delete | Public page; Clerk session for actions | Shared web account-data/deletion UI |
| GET /api/account/delete/export | Verified Clerk bearer subject | Existing owner-prefix object inventory |
| GET /api/account/delete/export/platform | Verified Clerk bearer subject | Owner-only portable platform record page |

Platform startup supplies the existing account runtime and persistent account secret. Routes derive owners solely from verified JWTs. Cursors are bounded, versioned, purpose/owner-bound and authenticated/encrypted with AES-GCM in deployed wiring. Invalid, failed and unavailable reads return generic errors, never a successful empty inventory. Account data remains exportable without scheduling deletion and after cancellation. Erasure admission/deadline behavior is unchanged.

## Backup files

Return the exact source LastModified ISO instant and object Size, or null when unavailable; never substitute export time or parse filenames as authoritative object metadata. Modification time is object upload time, not database snapshot capture completeness. Return kind, 900-second link lifetime and issuance expiry. Inventory traverses legacy/configured/v2 owner namespaces; continuation carries whether earlier pages contained portable objects. A complete empty traversal distinguishes no computer from missing backups, including historical computer records. Failed enumeration cannot be classified as empty. Preserve already-confirmed pages/cursor on retry. Refresh expired URLs by reauthorizing/relisting; existing URLs are bearer capabilities and are not instantly revoked. Relisting may see changed objects; this is not an immutable backup-set snapshot. Internal reachability metadata is excluded; owner files otherwise remain portable, including owner-controlled secret files.

## Platform records

Version 2 JSON keeps the existing groups and adds apps, appRatings, appInstalls, creditLedger, onboardingJourney. Only owner-authored apps and owner edges are included; private collaborators' rows are excluded. Explicit column allowlists omit runtime/operator provisioning details, integration credentials, billing keys/provider references, and access tokens. App source/config is owner-authored data, not a platform credential projection. Credit export includes amounts, kind, scope and timestamps, not source/reservation identifiers. Amounts outside JavaScript safe integer precision are decimal strings to preserve exact values. Onboarding exports phase/time, not internal detail payloads.

| Group | Owner boundary | Portable fields | Deliberate exclusions |
| --- | --- | --- | --- |
| profile | verified Clerk subject | IDs, handle, display name, email, plan/status, timestamps | container and integration identifiers |
| posts | owner platform user ID or Clerk subject | content/type, media/app references, counters, timestamp | other authors' posts |
| comments | owner platform user ID or Clerk subject | post/author IDs, content, timestamp | comments authored by other people |
| likes | owner platform user ID or Clerk subject | post/user IDs, timestamp | other people's edges |
| follows | owner platform user ID or Clerk subject | follower/following IDs and type, timestamp | edges created by other people |
| machines | verified Clerk subject, including historical rows | machine ID, handle/slot, status, provisioned/deleted times | registration tokens, provider IDs, networking and provisioning details |
| billing | verified Clerk subject | slot, plan, status, interval and period end | customer/subscription/price/invoice/provider IDs |
| onboarding | verified Clerk subject | completion time, goal, steps and source | none beyond the explicit row projection |
| apps | owner platform user ID or Clerk subject | authored metadata, source/config, visibility and timestamps | counters derived from other people; foreign-authored apps |
| appRatings | owner platform user ID or Clerk subject | app/user IDs, rating, review and timestamp | ratings authored by other people |
| appInstalls | owner platform user ID or Clerk subject | app/user IDs and install time | installs by other people |
| creditLedger | verified Clerk subject | entry ID, slot, kind, exact amount, period/expiry/create times | source references, reservations and payment/provider identifiers |
| onboardingJourney | verified Clerk subject | event ID, phase transition and timestamp | internal detail payloads |

Each page reads bounded ordered batches within a database transaction containing only export reads, with a 10-second statement timeout. Per-group keyset continuations avoid OFFSET and the old total-count cap. Creation-time cutoff applies where a creation timestamp exists; subscription summaries are live, and updates/deletions may change later pages. This is a resumable live export, not an MVCC snapshot across requests. Repeat a cursor safely; commit continuation only after saving its page. Clients download separate numbered JSON pages with explicit completion and can retry the same failed page without retaining the entire dataset in memory. Resource limits bound rows and bytes; oversized records fail explicitly/generically without silently truncating data. No new persistent export jobs or orphan artifacts.

## Validation and remaining qualification

Red tests cover real storage adapter -> export -> configured runtime -> route, isolated owner/foreign records, 10,005 posts, no-computer/missing-backup outcomes, deletion independence, and page retry. Add adversarial cursor/metadata/failure tests before the relevant fix. Validate native PostgreSQL and restore a synthetic custom-format dump with pg_restore. Verify Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile separately for timestamps, numbered record pages, completion, errors and retry. No customer export/account deletion is permitted for testing. Missing device/runtime access must remain explicit evidence risk.

Coordinate platform and Native Mobile client rollout: older clients can save a first page without a continuation action; owners must use the updated client or shared web page for complete exports. A separate FinnaAI/matrix-os-site documentation PR follows the stable application contract. Document deployed status from actual evidence, export scope, formats, freshness, pagination, signed-link expiry/retry and restoration; do not weaken constitutional ownership guarantees or imply automatic migration.
