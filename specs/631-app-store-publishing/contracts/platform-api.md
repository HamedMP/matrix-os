# Contract: Platform App Store API

The Zod schemas named here are exported from `@matrix-os/contracts/app-store`.

**Common rules**
- JSON responses unless an image endpoint explicitly declares bytes.
- Errors use the shape `{ error: AppStoreErrorCode }`, where the code is one of `invalid | unauthorized | forbidden | not_found | conflict | limit | unavailable`.
- Every mutating route has a `bodyLimit`.

## Per-VPS routes: `/internal/containers/:handle/app-store`

Auth is `Authorization: Bearer HMAC_SHA256(handle, PLATFORM_SECRET)`, compared timing-safe. The caller is the Clerk user of the running machine for `:handle`. A missing machine or user returns 403; a missing `PLATFORM_SECRET` returns 503.

| Method | Path | Body / query | Response | Notes |
| --- | --- | --- | --- | --- |
| GET | `/listings` | `AppStoreCatalogQuery` `{ q?, category?, sort?: popular\|rating\|new, cursor?, limit? ≤ 50 }` | `AppStoreCatalogPage` `{ listings: AppStoreListingSummary[], nextCursor? }` | `live` only |
| GET | `/listings/:slug` | — | `AppStoreListingDetail` (includes the caller's `myRating`, `myInstall`, `isPublisher`) | `live`, or any status for the publisher. A suspended listing returns its notice to prior installers only. |
| GET | `/listings/:slug/icon` | — | Image bytes (`image/png` or `image/svg+xml`, ≤ 256 KiB) with `Content-Security-Policy: default-src 'none'` | From the current version's source bundle cache |
| POST | `/listings/:slug/download` | `{ versionId }` | `AppStoreDownloadGrant` `{ versionId, version, source: { url, sha256, size }, approval: { keyId, signature }, capabilities, capabilitiesDigest, manifest }` | Source-only presigned GET valid for 15 min; authenticated gateway verifies approval against the trusted platform status key ring, exact compressed digest/size and per-file hashes before any local build. The version must be the current published version, or the caller must already have it installed. |
| PUT | `/listings/:slug/install` | `{ versionId }` | `AppStoreInstallState` | Idempotent upsert; counters change in the same transaction |
| DELETE | `/listings/:slug/install` | — | `AppStoreInstallState` | Marks the install uninstalled |
| PUT | `/listings/:slug/rating` | `{ stars: 1..5 }` | `AppStoreRatingState` `{ myRating, ratingAverage, ratingCount }` | 403 `forbidden` if never installed or if the caller is the publisher |
| DELETE | `/listings/:slug/rating` | — | `AppStoreRatingState` | |
| POST | `/submissions` | `AppStoreCreateSubmission` | `{ versionId, upload: { url, expiresAt }, status }` | Idempotent by `submissionKey`; claims the slug; enforces semver ordering |
| POST | `/submissions/:versionId/finalize` | — | `AppStoreSubmissionSummary` | Moves the version `awaiting_upload → scanning → in_review \| scan_failed` |
| GET | `/submissions` | `cursor?` | `{ submissions: AppStoreSubmissionSummary[], listings: AppStorePublisherListing[] }` | The caller's versions and listing metrics |
| POST | `/submissions/:versionId/withdraw` | — | `AppStoreSubmissionSummary` | CAS from withdrawable states |
| GET | `/status` | — | `AppStoreStatus` `{ enabled: boolean, reviewer: boolean, signingKeys: [{ keyId, publicKey }] }` | Authentication still required; the only route that answers while `MATRIX_APP_STORE_ENABLED` is off |
| GET | `/review/queue` | `{ status?: in_review\|changes_requested, cursor? }` | `{ items: AppStoreReviewQueueItem[], nextCursor? }` | Reviewer only |
| GET | `/review/versions/:versionId` | — | `AppStoreReviewDetail` (version, listing, capabilities, scan report, generalization report, file tree, previous version summary, events) | Reviewer only |
| GET | `/review/versions/:versionId/file` | `{ path, previous? }` | `{ path, size, text?: string, binary: boolean, truncated: boolean }` | ≤ 512 KiB of text; reviewer only |
| POST | `/review/versions/:versionId/decision` | `AppStoreReviewDecision` (union keyed by `type`: `approve`, `request_changes` `{message}`, `reject` `{message}`) | `AppStoreReviewQueueItem` | CAS on status; approve signs exact source and atomically publishes/version-supersedes/current-pointer/event; no build job |
| POST | `/review/listings/:listingId/action` | `AppStoreListingAction` (`delist`, `suspend`, `reinstate`; each with `{ message }`) | `AppStoreListingSummary` | Reviewer only |

`AppStoreCreateSubmission` fields:
- `submissionKey`
- `listing` (`{ slug, name, tagline, description, category }`)
- `version`, `changelog`, `license`
- `manifest`
- `source` (`{ sha256, size }`)
- `generalizationReport`.

The platform derives `capabilities` itself from the manifest.

## Removed

The `/api/store/*` routes (`store-api.ts`) and their `app-registry.ts` helpers are removed. The legacy `apps_registry`, `app_ratings` and `app_installs` tables stay in place, untouched, until a separate data-lifecycle change.

## Source approval signature

The signing helper uses Ed25519 over UTF-8 `canonicalJson({ domain: "matrix-app-store-source/v1", versionId, version, source: { sha256, size }, capabilitiesDigest, manifest })`. `capabilitiesDigest` is derived from the finalized manifest. Signature is encoded unpadded base64url (86 characters); `keyId` identifies the platform signing key. The authenticated `/status` response returns at most four public keys as SPKI PEM; the gateway validates and trusts keys only from its configured TLS-authenticated platform origin. Artifacts cannot inject keys. Private signing keys remain platform-only and explicit provisioning/rotation is a rollout prerequisite. Missing key configuration blocks approval, and absent/unknown/unverifiable signatures block installation. No builder routes, builder secret or dist download exists.
