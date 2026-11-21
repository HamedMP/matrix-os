# Contract: Gateway App Store API

These routes are served by the per-user gateway.
- **Owner check:** every route requires an owner principal (`MATRIX_USER_ID`/`MATRIX_CLERK_USER_ID`), the same check `registerAppGalleryRoutes` uses.
- **Who can call:** only the shell bridge for the `app-gallery` identity may call them (see `bridge-policy.md`). The review routes back the Gallery Review tab and are authorized by the platform's reviewer allowlist.
- **Errors:** responses use the shape `{ error: AppStoreErrorCode }`.
- **Methods:** only `GET` and `POST`, so the Web and Electron bridges share one small method set. The gateway maps these onto the platform's REST verbs.

## Publishing (`app-gallery` identity)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/app-store/publishable-apps` | — | `{ apps: AppStorePublishableApp[] }` `{ slug, name, icon?, description?, eligible: boolean, reason? }` |
| GET | `/api/app-store/drafts` | — | `{ drafts: AppStoreDraftSummary[] }` |
| POST | `/api/app-store/drafts` | `{ app: slug, aiConsent: { provider, disclosureVersion, consent: true } }` | `AppStoreDraftSummary` (201), starts the pipeline |
| GET | `/api/app-store/drafts/:draftId` | — | `AppStoreDraftDetail` (findings before/after, report, listing draft, changed files, AI status) |
| GET | `/api/app-store/drafts/:draftId/diff` | `?path=` | `{ path, change: added\|removed\|modified, before?: string, after?: string, truncated }` (≤ 256 KiB per side) |
| POST | `/api/app-store/drafts/:draftId/revise` | `{ instructions: string ≤ 1000 }` | `AppStoreDraftSummary` (202) |
| POST | `/api/app-store/drafts/:draftId/listing` | `AppStoreListingDraftPatch` | `AppStoreDraftDetail` |
| POST | `/api/app-store/drafts/:draftId/submit` | `AppStoreSubmitDraft` `{ consent: true, license }`; listing fields come from the draft | `AppStoreDraftSummary` |
| POST | `/api/app-store/drafts/:draftId/delete` | `{}` | `{ deleted: true }` |
| GET | `/api/app-store/submissions` | — | Platform `GET /submissions` |
| POST | `/api/app-store/submissions/:versionId/withdraw` | — | Platform withdraw |

## Catalog, install, rating (`app-gallery` identity)

| Method | Path | Body | Response |
| --- | --- | --- | --- |
| GET | `/api/app-store/listings` | `AppStoreCatalogQuery` | Platform page, with `installed` and `launchPath` merged from local provenance |
| GET | `/api/app-store/listings/:slug` | — | Platform detail, with `local: { installed, appSlug?, launchPath?, version?, updateAvailable }` merged |
| GET | `/api/app-store/listings/:slug/icon` | — | Proxied image (≤ 256 KiB, type allowlisted) |
| POST | `/api/app-store/listings/:slug/install` | `{ versionId, consent: { capabilitiesDigest } }` | `AppStoreInstallJob` `{ id, status: queued\|building\|installed\|failed, error?: unavailable\|build_failed\|invalid, appSlug?, launchPath? }` (202), or existing successful result for the already-installed fast path |
| GET | `/api/app-store/installs/:jobId` | — | Owner-scoped `AppStoreInstallJob`; durable progress after reopening Gallery |
| POST | `/api/app-store/listings/:slug/rating` | `{ stars: 1..5 \| null }`, where `null` removes the rating | Platform rating state |

`capabilitiesDigest` is `sha256(canonicalJson(capabilities))`. The gateway recomputes it from the download grant and refuses the request if it differs, so the user consents to exactly what is installed.

## Review (Gallery Review tab)

| Method | Path | Maps to |
| --- | --- | --- |
| GET | `/api/app-store/status` | Platform `/status` (also allowed for `app-gallery`) |
| GET | `/api/app-store/review/queue` | Platform `/review/queue` |
| GET | `/api/app-store/review/versions/:versionId` | Platform detail |
| GET | `/api/app-store/review/versions/:versionId/file` | Platform file |
| POST | `/api/app-store/review/versions/:versionId/decision` | Platform decision |
| POST | `/api/app-store/review/listings/:listingId/action` | Platform listing action |

Platform errors map to the same `AppStoreErrorCode`. The gateway never forwards platform bodies it has not validated.

## Local build semantics

Install/update downloads only approved source. Gateway verifies the authenticated grant/signature/digest/length/file hashes and capability consent, fetches pinned dependencies with the restricted registry broker, then runs offline install/build inside the OS isolation adapter. No host Vite invocation is allowed. It publishes source plus its own locally generated dist only after success, then records the install metric. Missing isolation/signing trust returns unavailable; build failure keeps the old install intact. Repeated installs reuse an active job for the same source/version. Job polling has owner auth, UUID validation, bounds and finished-job TTL; app frames cannot poll another owner's jobs.

Provider consent must precede AI source transmission and name the selected provider. It is separate from final submission consent. The exact API schema for obtaining/revising provider consent must be shared across UI and gateway before implementation; do not silently treat draft creation or platform-upload consent as provider consent.
