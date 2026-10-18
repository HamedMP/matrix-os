# Implementation alignment: App Store publishing

Tracking: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery). Stack: `app-store-publishing`.

These notes describe the implemented platform layer. They supplement the design and do not establish live qualification of the complete stack.

## Platform persistence and source identity

- `packages/platform/src/app-store/migration.ts` runs in independent migration scope `app-store`. Its current revision is generation **2**; the core platform revision is unchanged. Generation 2 adds nullable `app_store_versions.upload_cleaned_at` for durable upload cleanup.
- Publisher, installer, rater and reviewer identities come from an authenticated handle and authoritative active machine/user records. JSON bodies cannot select another identity.
- Upload objects use `app-store/owners/<Clerk-user-ID>/uploads/<version-ID>`.
- Verified source objects use `app-store/owners/<Clerk-user-ID>/sources/<version-ID>/<SHA-256>`.
- Finalization reads at most 16 MiB compressed with a 30-second transport deadline, checks the declared length and digest, decodes and checks every bundle file, matches the strict normalized manifest, derives capabilities, scans source and checks additive storage. A pnpm lockfile and a declared Vite dependency are required. Truncated scans block review.
- Passing source is copied to the separate verified key before its review state is committed. Reviewers and installers never consume the publisher-writable upload key: a still-valid presigned PUT cannot replace approved bytes.
- Staff approval signs the exact source length/digest, version identity, normalized manifest and capability digest using Ed25519. Publication, predecessor supersession, listing metadata/current pointer and moderation event commit in one transaction under the listing lock. Missing signing configuration fails approval closed.
- Install and rating changes take the listing lock, then update the edge and counters in the same transaction. Repeated installs do not increase unique download counts. Ratings require an installation and publishers cannot rate their own listings.
- There are no platform build jobs, builder routes or distributed `dist` artifacts. Source builds occur on each installer's VPS through the shared local isolation service.

## Platform configuration

| Setting | Meaning |
| --- | --- |
| `MATRIX_APP_STORE_ENABLED` | `true` or `1` enables routes; otherwise authenticated `/status` remains available. |
| `MATRIX_APP_STORE_REVIEWER_CLERK_IDS` | Comma-separated reviewer IDs; validated, capped at 100 entries. |
| `MATRIX_APP_STORE_SIGNING_KEY_ID` | Active signing key identifier. |
| `MATRIX_APP_STORE_SIGNING_PRIVATE_KEY` | Platform-only Ed25519 PKCS#8 PEM. Keep in private secret configuration. |
| `MATRIX_APP_STORE_PREVIOUS_SIGNING_KEYS` | Optional JSON array of up to three `{keyId, publicKey}` verification keys. The authenticated status response exposes at most four public keys including the active key. |
| `PLATFORM_SECRET` | Existing per-handle HMAC authentication authority. Never send this secret to an app or sandbox. |
| Primary `R2_*` / `S3_*` object storage | Current startup borrows the primary sync storage client for owner-scoped App Store objects. `R2_BUNDLES_*` alone does not provide this client. |
| `MATRIX_INTERNAL_CLERK_ORG_ID` and collaboration organization projection | Existing Private Preview membership authority; required for private-preview machine access. |

The startup process owns shared storage/database resources. The store runtime borrows them and drains its cleanup work on shutdown.

Requests have a 512 KiB body limit for every mutation. Admission is bounded to four concurrent requests and 120 requests/minute per authenticated handle. Additional owner/action quotas are ten submissions/hour, sixty install changes/hour and sixty rating changes/hour. The bounded limiter maps expire old entries and evict the oldest at capacity. Review file text is capped at 512 KiB; icons are PNG or SVG capped at 256 KiB with a restrictive response CSP.

## Cleanup and account ownership

- Stuck scans become retryable after ten minutes. An hourly sweeper processes bounded batches and is drained during shutdown.
- Upload grants last fifteen minutes. Uploads older than twenty-four hours cannot obtain another grant. Cleanup waits twenty-four hours plus fifteen minutes, so a renewed PUT cannot recreate an object after its durable record is removed.
- Expired awaiting-upload records and objects are removed. Processed upload copies are deleted separately and marked with `upload_cleaned_at`; verified source remains available for published versions.
- Object deletion failure leaves a durable retry candidate. Cleanup does not silently mark a failed deletion complete.
- Account exports include store listings, versions, installs and ratings, plus source/upload objects through the canonical `app-store/owners/<Clerk-user-ID>/` storage boundary.
- The existing account-deletion pipeline erases owner storage before its platform-data transaction. Store cleanup delists and anonymizes retained published listings, removes private submissions, removes the deleting user's install/rating edges with locked counter updates, and removes private reports and owner identifiers. Other installers' records and their local source/data remain intact. Deleted-publisher listings cannot be reinstated or receive new installs/downloads.
- Ordinary moderation remains append-only. Account erasure is an explicit lifecycle exception: retained moderation actor identifiers and private messages are anonymized/cleared within the existing owner-erasure transaction.

## Runtime authority for validation

An ordinary shared `preview` machine cannot act as a personal store publisher, installer or reviewer using its machine bearer. Owner-only `private-preview` access reuses `PrivatePreviewEligibility` without a new trust bypass: reserved handle/runtime slot, no collaborators, running/nondeleted state, age below 72 hours and current internal Clerk-organization membership must all hold. Missing or unreadable membership fails closed. Customer runtimes also require an active authoritative owner and reject shared handle records.

A branch platform revision and a branch host bundle are separate deployments. Publishing a host bundle does not update platform routes. The current `preview-platform` workflow uses the staging database and preview authority but does not bind the new store feature settings, approval signing key or primary object storage credentials. Those are explicit staging prerequisites, not evidence that live publishing already works.

For a complete isolated staging connection:

1. Publish the exact full-stack PR host bundle with `preview-bundle`/bundle-only registration (`--channel none`); preserve PR/head provenance and never promote a shared release channel for a feature test.
2. Deploy that same reviewed head to a zero-default-traffic revision of the dedicated preview platform service. Use its staging database, preview HMAC/JWT/collaboration keys, a preview-only store signing key and isolated primary object storage. Set the feature flag and reviewer IDs only there.
3. Use a disposable owner-only runtime whose authoritative machine and owner records belong to that staging authority. A Private Preview additionally needs fresh internal membership in the staging collaboration projection. The default preview service has no Hetzner token and cannot provision this runtime by itself.
4. Ensure the runtime's gateway connection, machine bearer, proxy authentication and any enabled internal service tokens all match the staging authority. `PLATFORM_INTERNAL_URL` and `UPGRADE_TOKEN` are shared gateway settings, so changing them affects integrations as well as the store. Preserve the explicitly confirmed host-bundle/update pin and rollback configuration. A production-private-preview row alone does not establish a staging identity.
5. Open the staging runtime in the in-app browser, verify authenticated status/keys and the exact installed head, then perform the publisher → reviewer → second installer scenario with synthetic data. Capture every affected surface separately and record fixture/access limitations.
6. Restore/release temporary staging routing, remove temporary identity/object fixtures and destroy the disposable runtime through its owning platform after validation.

See [Preview environments](../../docs/dev/preview-environments.md), [staging platform and feature VPS runbook](../../docs/dev/staging-platform-vps.md), and [qualification requirements](quickstart.md). Prefer current workflows and their channel-none preview provenance rules over older runbook examples that publish to `dev`.

## Verification recorded for the platform layer

The focused App Store and related account-deletion/migration regression run passed **77 tests across 12 modules**. Platform source/typecheck configurations passed; the pattern scan reported zero violations. Database tests used the repository's standard PGlite fixture fallback because a native PostgreSQL fixture URL was not configured. The production Hono route composition was exercised locally. These results do not substitute for native PostgreSQL contention testing, an isolated live VPS build, or the required surface captures.
