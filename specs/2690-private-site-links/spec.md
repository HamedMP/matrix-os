# 2690: One-Time Private Links for Matrix.page

Status: implementation
Issue: https://linear.app/matrix-os/issue/ENG-437/featsites-add-one-time-private-access-links
Related: [ENG-231](https://linear.app/matrix-os/issue/ENG-231), [ENG-29](https://linear.app/matrix-os/issue/ENG-29), [Public App Sites](../551-public-app-sites/spec.md)
Baseline: `origin/main` at `bc52a37f6841fd2a341e04f5b9722b6bd5c96af7`

## Goal and scope

Add `Private — one-time links` as an access mode for an existing Matrix.page publication. An owner creates independently claimable URLs without a per-site total cap. A visitor explicitly claims one URL in one browser and receives a site-specific 30-day browser session. The app then opens through the existing sandboxed Matrix.page wrapper, assets, and declared form boundary.

No Clerk account, Matrix onboarding, computer provisioning, email delivery, visitor identity, private runtime access, new app capability, or native-mobile owner management is introduced. The existing iframe sandbox, CSP, opaque origin, `MatrixOS.site.data`, and declared form schema remain authoritative.

## Product behavior

- Publications have `accessMode: "public" | "private_link"`; migration defaults all existing rows to `public`.
- An unclaimed link expires seven days after creation. A successful claim grants that browser 30 days of access.
- The claim URL is returned once as `https://matrix.page/<permanent-site-id>#access=<link-id>.<secret>`. The fragment is not sent in the initial HTTP request, logs, or referrers.
- The generic private wrapper reveals no app title or owner metadata. JavaScript reads the fragment but sends it only after the visitor clicks **Open shared app**, preventing preview scanners from claiming links.
- After claim, the wrapper removes the fragment and reloads the canonical URL. Refreshes work with the site-scoped cookie. Reuse in another browser fails with the same generic unavailable result as other invalid credentials.
- Owners can page through non-secret link status (`Unclaimed`, `Claimed`, `Expired`), timestamps, and revoke links.
- Conflict recovery preserves draft metadata but refreshes an untouched access selection from the latest publication. An explicit owner access-mode change remains an intentional override.
- Switching private to public or unpublishing deletes all link and session rows in the same transaction. Switching back to private never restores them. Updates and rollbacks preserve valid access.
- Revocation blocks new requests. Bytes already delivered to a browser cannot be remotely erased. Losing browser cookies requires a new link.
- PostHog records successful Matrix.page lifecycle outcomes for publish/update, settings and access-mode changes, unpublish, rollback, link create/claim/revoke, canonical page views, and accepted form submissions. Events use only low-cardinality state such as access mode and operation; they never include site/link IDs, URLs, slugs, titles, descriptions, form IDs or fields, tokens, cookies, or source addresses.

## Data ownership and model

`public_sites.access_mode` is platform routing metadata owned by the publication owner. `public_site_access_links` is an owner-scoped platform table with a cascading site foreign key:

- `id`, `site_id`
- SHA-256 `claim_token_hash` and nullable `session_token_hash`
- `created_at`, `claim_expires_at`, nullable `claimed_at`, nullable `session_expires_at`

Plaintext tokens are never persisted or returned by list/export APIs. Owner export includes only link IDs, site IDs, status timestamps, and the publication access mode. Account deletion revokes sessions before object cleanup and the site cascade deletes remaining rows.

## Runtime wiring

Owner UI → verified gateway owner route → machine-authenticated platform management route → owner/site transaction in platform Postgres.

Visitor browser → Matrix.page Worker → edge-proofed platform public route. The Worker permits only the exact viewer cookie for the permanent site ID in the request path, strips Clerk/authorization/unrelated and other-site cookies, and accepts only validated site-matching `Set-Cookie` values. The platform resolves the active publication and validates the session hash before returning the wrapper/frame or forwarding a form.

Claim flow:

1. Initial `GET /<reference>` has no secret on the wire and returns the generic claim wrapper for a private publication without a valid viewer cookie.
2. Explicit click sends the exact `{ linkId, token }` body to `POST /<reference>/access/claim` from the Matrix.page origin.
3. The platform takes the owner advisory lock, site row lock, then link row lock; checks site state/mode, site/link binding, expiry, unclaimed state, and a constant-time hash match.
4. One conditional update writes the claim time, new random session hash, and session expiry. The response contains a site-path-scoped `HttpOnly; Secure; SameSite=Lax` viewer cookie.
5. The browser clears the fragment and reloads. The authenticated `/frame` navigation revalidates the viewer cookie, loads the bounded active Vite build from owner storage, rewrites its local module graph and resources to data URLs, and returns the complete sealed build in that one opaque-frame response. Linked stylesheets retain document order, dynamically imported styles remain lazy, and `new URL(..., import.meta.url)` retains URL-object semantics. A four-entry, five-minute LRU caches only immutable packaged build bytes, never authorization decisions or credentials.
6. All private entry points revalidate the current row. Direct private asset routes always fail closed, so an unrelated opaque sandbox cannot use a viewer's browser as a credentialed asset oracle. Wrapper, frame, and form requests continue to require the site-bound viewer session.

The platform database is the source of truth for access mode, link claim state, session validity, and revocation. The browser cookie is only a bearer presented for hash verification.

## Authentication matrix

| Route | Authentication/authorization | Public |
| --- | --- | --- |
| `GET /api/apps/:slug/site/access-links` | Existing verified gateway owner principal; platform machine bearer bound to owner/runtime/app | No |
| `POST /api/apps/:slug/site/access-links` | Same owner chain, current publication revision, published private site | No |
| `DELETE /api/apps/:slug/site/access-links/:linkId` | Same owner chain and site-bound link ID | No |
| `GET /:reference` | Worker edge proof; public mode or valid site viewer session. Invalid private sessions receive generic gate/unavailable content | Yes |
| `POST /:reference/access/claim` | Worker edge proof, same-origin browser request, exact bounded claim payload, active private site and unclaimed site-bound link | Yes |
| `GET /:reference/frame` | Worker edge proof plus valid site viewer session for private sites; private builds are sealed into this response | Yes |
| `GET /:reference/assets/:version/*` | Worker edge proof; public publications only. Private publication assets always return unavailable | Yes |
| `POST /:reference/forms/:formId` | Worker edge proof, valid private viewer session, existing form admission and exact declared schema | Yes |

No user-controlled forwarding header, Clerk cookie, owner cookie, or Authorization header establishes viewer access.

## Security, limits, and failures

- Claim and management bodies use strict Zod schemas and 2 KiB body limits. Query-string credentials are unsupported.
- Claim tokens and session tokens contain 256 random bits encoded as 43 base64url characters. Hash comparisons use `timingSafeEqual` after exact shape validation.
- Cookie input is capped at 8 KiB. The Worker forwards at most the exact viewer cookie whose suffix matches the permanent site ID in the path; cookies for other claimed sites cannot accumulate into a request or consume its allowance. Platform parsing remains site-specific.
- The viewer cookie is Lax and scoped to `/<site-id>`. Private app code and resources are returned only inside the authenticated sealed frame response; there is no cross-site asset cookie or credentialed CORS route.
- An invalid private wrapper session returns the generic gate and an exact `Max-Age=0` deletion for the site-scoped viewer cookie. A private-to-public transition clears the same remnant on the next canonical page request; the Worker forwards only a deletion whose cookie suffix and path match that permanent site ID.
- Private packaging accepts at most 200 files and 10 MiB of source bytes, checks every resource substitution before materializing it, caps the produced frame at 15 MiB, loads at most eight objects concurrently, and uses a four-entry TTL/LRU cache. Missing or non-literal local build dependencies fail closed.
- Link creation has no per-site total cap. Owner list responses are keyset-paginated at no more than 100 rows, while existing owner and public rate/in-flight admission caps apply; claim uses the bounded mutation admission path so revocation remains available.
- Lock order is owner advisory lock → site row → link row. Related changes are transactional and optimistic publication revision checks occur in the write transaction.
- All responses are `no-store`. Public errors are generic. Tokens and hashes are excluded from logs, owner list responses, and export.
- Cross-site link IDs/tokens, expired claims/sessions, claimed link reuse, malformed/oversized cookies, cross-site claim requests, and direct private frame/asset/form access fail closed.
- Immutable asset upload remains the only accepted distributed orphan state: a failed deployment may leave owner-prefixed candidate bytes for bounded cleanup/account erasure. Access-link mutations have no external side effect and allow no orphan state.

## Compatibility and rollout

Deploy in this order:

1. Platform migration and services. Existing publications become `public`; owner export and deletion understand link metadata.
2. Matrix.page Worker cookie/claim forwarding allowlist.
3. Gateway and shell owner controls. Do not expose the private-link selector until platform and edge support are deployed.

During the platform-first window, management callers that do not send the versioned sites-contract capability header receive the legacy site response shape without `accessMode`, and legacy access-link listings contain only `{ links }`. Updated Gateways negotiate contract version 2 and receive the complete site record plus paginated `{ links, nextCursor }` listings. This applies to reads and mutation responses so an older Gateway never reports a successful response as an upstream schema failure. A caller without negotiation that nevertheless submits `accessMode` is an ambiguous access-aware client and fails before mutation; a genuinely legacy caller omits that field and remains compatible. This prevents an unversioned client from defaulting a stripped private mode to public and sending it back.

Rollback of shell/gateway controls leaves existing private publications enforceable at the platform/edge. Rolling platform code back across the migration is unsupported without first returning private sites to public or unpublishing them; the additive table/column may remain safely.

## Verification and delivery

- Regression tests cover migration default, one concurrent claim winner on independent PostgreSQL connections, exact seven/30-day expiry, more than 50 links with bounded pagination, revocation, cross-site denial, public/private/unpublish transitions, secret absence, privacy-safe success-only telemetry, cookie allowlists, sealed opaque-frame packaging, cookie accumulation, and fail-closed wrapper/frame/asset/form routes.
- UI tests cover mode changes, copy-once URL display, replay masking, revision-conflict recovery, metadata status, safe errors, and revocation.
- A real browser journey uses two clean profiles: profile A claims and refreshes; profile B cannot reuse; revocation blocks A. Public Matrix.page and authenticated private form submission are checked separately.
- Live evidence is required for Web Canvas, Web Desktop, Electron Desktop, Web Mobile, and desktop/mobile Matrix.page viewing. Native Mobile owner management is unsupported until separately approved.
- Ship through the ENG-437 worktree PR with current-head CI, Greptile 5/5, product/security review recommendation, captures in the PR and Slack `#tech`, and a separate public-docs PR in `FinnaAI/matrix-os-site`.
