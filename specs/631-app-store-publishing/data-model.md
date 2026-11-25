# Data Model: App Store Publishing

## Platform Postgres (migration scope `app-store`)

The tables are created by `packages/platform/src/database/app-store-migration.ts`. It runs as its own migration scope (like `whatsapp`) with its own revision in `app-store-migration-revision.ts`, so it does not bump the core platform schema revision. Timestamps are ISO-8601 `TEXT` and IDs are UUID `TEXT`, matching platform conventions.

### `app_store_listings`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | UUID |
| `slug` | text UNIQUE NOT NULL | `^[a-z][a-z0-9-]{2,47}$`; claimed by first submission |
| `publisher_clerk_user_id` | text NOT NULL | From the per-VPS token's handle |
| `publisher_handle` | text NOT NULL | Display only; refreshed on each submission |
| `name` | text NOT NULL | ≤ 60 |
| `tagline` | text NOT NULL | ≤ 100 |
| `description` | text NOT NULL | ≤ 2000 |
| `category` | text NOT NULL | One of `APP_STORE_CATEGORIES` |
| `status` | text NOT NULL | `pending` (no published version yet), `live`, `delisted`, `suspended` |
| `current_version_id` | text NULL | FK → `app_store_versions.id` (deferred check in code) |
| `install_count` | integer NOT NULL DEFAULT 0 | Unique installing users, ever |
| `active_install_count` | integer NOT NULL DEFAULT 0 | Installs without `uninstalled_at` |
| `rating_sum` | integer NOT NULL DEFAULT 0 | Sum of current stars |
| `rating_count` | integer NOT NULL DEFAULT 0 | Number of current ratings |
| `created_at`, `updated_at` | text NOT NULL | |

Indexes: `(status, install_count DESC)`, `(status, created_at DESC)`, `(publisher_clerk_user_id)`. Listing metadata (name, tagline, description, category) is copied from a version when it is published.

### `app_store_versions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | UUID |
| `listing_id` | text NOT NULL FK | |
| `version` | text NOT NULL | Strict semver; UNIQUE (`listing_id`, `version`) |
| `version_major`, `version_minor`, `version_patch` | integer NOT NULL | Used for ordering |
| `submission_key` | text UNIQUE NOT NULL | `<handle>:<draftId>:<version>`; makes submit idempotent |
| `submitted_by_clerk_user_id` | text NOT NULL | |
| `status` | text NOT NULL | See state machine |
| `name`, `tagline`, `description`, `category` | text NOT NULL | Listing fields proposed by this version |
| `changelog` | text NOT NULL | ≤ 2000 |
| `license` | text NOT NULL | One of `APP_STORE_LICENSES` |
| `capabilities` | jsonb NOT NULL | `AppStoreCapabilities`: integrations, permissions, tables |
| `manifest` | jsonb NOT NULL | Sanitized store manifest |
| `source_object_key` | text NOT NULL | Server-generated R2 key |
| `source_sha256`, `source_size` | text, integer NOT NULL | Declared at create; verified at finalize |
| `approval_key_id`, `approval_signature` | text NULL | Ed25519 signature bound to exact approved source/version/manifest/capabilities; required for published versions |
| `scan_report` | jsonb NULL | `AppStoreScanReport` from platform re-scan |
| `generalization_report` | jsonb NOT NULL | `AppStoreGeneralizationReport` from the publisher VPS |
| `reviewer_message` | text NULL | ≤ 2000 |
| `decided_by_clerk_user_id`, `decided_at` | text NULL | |
| `scanning_started_at`, `published_at` | text NULL | |
| `created_at`, `updated_at` | text NOT NULL | |

Indexes: `(status, created_at)` (queue) and `(listing_id, version_major DESC, version_minor DESC, version_patch DESC)`.

#### Version state machine

```
awaiting_upload ──finalize──▶ scanning ──▶ in_review ──approve──▶ published ──newer published──▶ superseded
       │                         └──▶ scan_failed    ├─request_changes─▶ changes_requested
       └─24h sweeper─▶ deleted                       └─reject─▶ rejected
withdraw: awaiting_upload | scan_failed | in_review | changes_requested ──▶ withdrawn
```

- Every transition uses `UPDATE … WHERE id = ? AND status = ?`; zero rows means conflict. Serialize per-listing approval/semver transitions with a listing row lock so concurrent versions cannot regress the current pointer.
- Stale scanning rows return to awaiting_upload after 10 minutes so finalize is retryable.
- Approval signs `canonicalJson({domain:"matrix-app-store-source/v1", versionId, version, source:{sha256,size}, capabilitiesDigest, manifest})` with the platform Ed25519 private key. This signing payload contains the exact sanitized manifest approved by staff; `capabilitiesDigest` is SHA-256 of canonical derived capabilities. An absent/unusable signing key fails approval before any publication mutation.
- One transaction records the source approval signature, marks the version published, supersedes its predecessor, updates current pointer/metadata/status, and records the reviewer approval event. Delisted/suspended listings require an explicit permitted action to become live; approving an update must not accidentally reinstate them.
- There are no platform build jobs, leases, dist columns or builder callback states. Local installer failure cannot mutate publication state.

### `app_store_ratings`

| Column | Type | Notes |
| --- | --- | --- |
| `listing_id` | text NOT NULL FK | PK part |
| `clerk_user_id` | text NOT NULL | PK part |
| `stars` | smallint NOT NULL | CHECK 1–5 |
| `created_at`, `updated_at` | text NOT NULL | |

Each upsert or delete runs in one transaction. It first locks the listing row (including when the rating row is absent), then locks the existing rating row (`SELECT … FOR UPDATE`), writes the new row (`INSERT … ON CONFLICT (listing_id, clerk_user_id) DO UPDATE`), then applies the delta (`rating_sum += new - old`, `rating_count += 0|1|-1`) with a targeted `UPDATE`.

### `app_store_installs`

| Column | Type | Notes |
| --- | --- | --- |
| `listing_id` | text NOT NULL FK | PK part |
| `clerk_user_id` | text NOT NULL | PK part |
| `version_id` | text NOT NULL | Last installed version |
| `first_installed_at`, `last_installed_at` | text NOT NULL | |
| `uninstalled_at` | text NULL | |

Recording an install runs in one transaction, locking the listing row before the upsert so absent-row races cannot double-count. The authenticated gateway reports completion only after source verification, local isolated build and durable local publication. A first insert adds 1 to `install_count` and 1 to `active_install_count`. Reactivating a row whose `uninstalled_at` is set adds 1 to `active_install_count`. Reinstalling while already active changes neither counter. Uninstalling sets `uninstalled_at` and subtracts 1 from `active_install_count`, but only when the row was active.

### `app_store_moderation_events` (append-only)

| Column | Type | Notes |
| --- | --- | --- |
| `id` | text PK | |
| `actor_kind` | text NOT NULL | `reviewer`, `publisher`, `system` |
| `actor_clerk_user_id` | text NULL | |
| `action` | text NOT NULL | `submitted`, `scan_passed`, `scan_failed`, `approve`, `request_changes`, `reject`, `published`, `withdrawn`, `delist`, `suspend`, `reinstate` |
| `listing_id` | text NOT NULL | |
| `version_id` | text NULL | |
| `message` | text NULL | ≤ 2000 |
| `created_at` | text NOT NULL | |

There is no update or delete path in the repository.

## Publisher VPS: drafts (`~/data/app-store/drafts/<draftId>/`)

The namespace is created with mode 0700 and added to `DENIED_FILE_API_PREFIXES`.

```
drafts/<draftId>/
  draft.json          # AppStoreDraftRecord, written atomically (tmp + rename)
  source/             # pinned snapshot of ~/apps/<slug> (read-only reference for diffs)
  work/               # generalized copy (agent's only writable root)
  bundle.json.gz      # deterministic bundle, created at submit
```

`AppStoreDraftRecord` contains:
- `id`, `sourceSlug`, `status` (`preparing`, `ready`, `needs_attention`, `failed`, `submitting`, `submitted`), `stage` (`snapshot`, `scan`, `generalize`, `verify`, `package`, `upload`), `failureCode`
- `findings` (before and after), `report` (the generalization report), `listing` (the listing draft), `ai` (`completed`, `unavailable`, `failed`)
- `providerConsent` (selected provider, disclosure version and consent time), `submissionConsent` (reviewed digest/license/disclosure/time); these are separate decisions
- `verification` (isolated build status, supported adapter/toolchain identity, source digest, generic failure code); unavailable isolation never produces ready
- `submission` (`{ listingSlug, version, versionId }`)
- `createdAt`, `updatedAt`, `expiresAt` (created plus 7 days).

## Installer VPS: community provenance (`~/system/app-store/installs.json`)

This file is gateway-owned and written atomically. It contains `{ version: 1, installs: AppStoreInstallRecord[] }`. Each `AppStoreInstallRecord` holds:
- `listingSlug`, `appSlug` (the installed folder), `versionId`, `version`
- `sourceSha256`, `sourceSize`, `approvalKeyId`, `approvalSignature`, `localDistSha256`, `toolchainId`, `isolationAdapterVersion`
- `capabilities` (as consented), `installedAt`, `updatedAt`.

This file, not the app's editable `matrix.json`, decides whether an app is `community`. Integration grants are written to the existing `~/system/app-capabilities.json`, limited to the consented services and actions.

## Installer VPS: local install jobs

Gateway-owned private records track `{ id, listingSlug, versionId, sourceSha256, status, error?, appSlug?, launchPath?, createdAt, updatedAt }`. Status is `queued | building | installed | failed`; generic errors are `unavailable | build_failed | invalid`. Persist atomically; cap at 16 jobs, max 2 queued, one active build per owner, expire finished jobs after 7 days with symlink-safe recurring cleanup. Retry for the same listing/version/source reuses an active job. On restart in-flight jobs become failed/interrupted with private staging reclaimed; reconcile commit/provenance/grants before marking installed. Job data and build logs are not app-readable.

Local output and build stamps are scoped to the actual built source and pinned toolchain. Their digest records this installer output; it never substitutes for the approved source digest. Update publication keeps a recoverable prior version until all durable ownership/grant records agree, then removes the replaced snapshot under the cleanup policy. Metrics retries are idempotent and may lag local success, never precede it.
