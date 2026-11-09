# Runtime Boundaries and Auth Matrix

## Route matrix

| Route family | Reachability | Authority | Boundary validation | Failure policy |
| --- | --- | --- | --- | --- |
| Gateway `/api/apps/:slug/site/invitations*` | Matrix owner shell | Existing verified owner principal for exact app/runtime | Zod path/query/body, 32 KiB create, 2 KiB mutations, 100 addresses, keyset limit ≤100 | Generic 4xx/503; never expose recipient inventory for foreign/missing site |
| Platform `/internal/containers/:handle/sites/:appSlug/invitations*` | Gateway only | Existing machine bearer bound to owner, machine, slot, and epoch | Same shared schemas; resolve dependency at registration | Generic denial; Preview/delegated runtimes fail closed |
| Matrix.page `GET /:reference` | Public | Public mode, or active exact viewer session; otherwise gate only | Strict reference; private alias redirects to permanent UUID | No private app bytes or invitation existence leak |
| Matrix.page `POST /:siteId/access/email` | Public but protected | Exact same Origin + edge proof + valid Clerk bearer; active grant or verified email matching current invitation | UUID path, empty ≤2 KiB JSON, bearer ≤8 KiB, strict Clerk response ≤1 MiB | One coarse invitation-unavailable denial across all identity/state failures |
| Matrix.page `GET /:siteId/frame` | Public but protected | Exact mode-specific viewer cookie and active grant/session | UUID path, exact approved cookie grammar | Generic unavailable; no redirects |
| Matrix.page private assets | Not directly readable | None | Existing strict path allowlist | Deny; sealed authenticated frame is the only private package response |
| Matrix.page forms/actions/data | Public but protected | Same active viewer grant plus existing visitor schema/quota/admission | Existing strict Zod schemas and body limits | Generic unavailable/rate error; never owner/provider details |
| Clerk `/webhooks/clerk/users` | Clerk only | Valid Svix signature and configured secret | 64 KiB pre-buffer limit, event schema, event ID/time dedupe | Non-2xx on processing failure so provider retries |

## Credential flow

1. Owner sessions terminate at Gateway. Gateway forwards only the existing
   machine/slot/epoch-bound Platform bearer.
2. The trusted Matrix.page auth gate obtains a short-lived Clerk session token.
3. The Worker accepts `Authorization` only for the exact canonical email
   exchange route and replaces all other headers with its fixed allowlist.
4. Platform verifies the token, then fetches authoritative Clerk user state.
5. Platform returns a raw Matrix viewer secret exactly once in a strict
   site-path cookie; only its hash is stored.
6. The Worker forwards only the exact cookie whose name/path suffix matches the
   canonical site ID. It drops Clerk cookies, unrelated Matrix cookies, and
   authorization from all content paths.
7. The sandboxed app frame cannot read the HttpOnly cookie or Clerk token.

Tokens, cookies, email addresses, Clerk IDs, invitation URLs, provider payloads,
and raw failures are excluded from logs, analytics, audit details, and exports.

## Trusted gate versus untrusted app frame

- The auth gate is first-party Matrix HTML and may load only reviewed Clerk
  script/connect/image/frame origins required by the successful Phase 0 spike.
- The gate uses `@matrix-os/brand` tokens and contains no owner app HTML.
- The app remains an opaque sandboxed frame with `PRIVATE_APP_CSP`; no Clerk
  origin is added to `APP_CSP` or `PRIVATE_APP_CSP`.
- Authentication success always targets the current server-rendered canonical
  site ID. Arbitrary client `return_url`, `redirect_url`, `next`, or Host/
  forwarded-host values are ignored.
- `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `frame-ancestors
  'none'`, and `base-uri 'none'` apply to the gate.

## Input and resource limits

| Resource | Limit / cleanup |
| --- | --- |
| Owner create body | Hono `bodyLimit` 32 KiB before JSON buffering |
| Owner mutation body | 2 KiB, including DELETE |
| Address batch | 1–100 strings; raw string ≤320, accepted normalized address ≤254 |
| Inventory/audit page | Keyset only, default 50, maximum 100; cursor ≤4096 |
| Viewer exchange | Canonical UUID, same Origin, empty JSON ≤2 KiB, bearer ≤8192 |
| Clerk Backend response | 1 MiB streaming bound; strict Zod parsing |
| External calls | 10 seconds, `redirect: "error"`, fixed reviewed origins |
| Delivery batch | 25 jobs, five-minute lease, at most five attempts |
| Active browser sessions | 20 per grant; oldest active session revoked on overflow |
| Immutable private packages | Existing four-entry/five-minute byte cache only; auth decision never cached |
| Delivery rows | Sent/cancelled operational rows removed after 30 days |
| Timers/resources | Recurring sweeps cleared on shutdown; active batch bounded to five-second drain; owned DB/provider resources closed by their owner |

## Runtime wiring

Startup order in Platform:

1. Run the generation-3 Sites migration and verify the access-mode constraint.
2. Construct existing Sites repository/object storage dependencies.
3. Construct `SiteInvitationMailer` only from validated deployment config; a
   missing mailer keeps the capability false rather than creating a partially
   working route.
4. Construct invitation repository/service, viewer-session service, delivery
   worker, and audit repository with explicit Kysely, clock, randomness, Clerk
   verifier/user resolver, and telemetry dependencies.
5. Register machine-authenticated management routes and edge-proofed public
   routes. Registration fails if a route's required dependency is undefined.
6. Start bounded expiry/delivery cleanup only after route dependencies and DB
   readiness succeed.
7. On shutdown, stop admissions/timers, drain delivery, then destroy only pools
   and clients owned by the Sites registration.

Cross-package chain:

```text
PR #3200 Share panel
  -> shared site client
  -> owner-authenticated Gateway route
  -> machine-bound Platform management route
  -> owner/site lock + invitation/outbox transaction
  -> bounded mail worker

Matrix.page gate
  -> ClerkJS identity proof (Phase 0 exact-URL gate)
  -> same-origin Worker exchange allowlist
  -> Platform Clerk verifier + authoritative user lookup
  -> invitation/grant/session transaction
  -> path-scoped cookie
  -> wrapper + sealed frame + visitor route revalidation
```

No `globalThis`, client-only policy, shell-local registry, or owner VPS is an
authorization dependency.

## External mail contract

`SiteInvitationMailer.send()` accepts only a bounded value object:

```ts
interface SiteInvitationMail {
  deliveryId: string;
  to: string;
  appTitle: string;
  inviterDisplayName: string;
  canonicalUrl: `https://matrix.page/${string}`;
  expiresAt: string;
}
```

The adapter owns provider-specific templating and returns only a bounded opaque
message reference. It must not accept arbitrary origins, HTML, headers, sender,
or reply-to values from the owner. The canonical URL is constructed from the
stored UUID, never from request Host or owner input. Provider errors are mapped
to coarse internal codes and logged by class/name only.

## Mode cleanup rules

- Leaving `private_link` deletes/revokes one-time-link credentials.
- Leaving `private_email` revokes invitations, grants, viewer sessions, and
  pending delivery in the same owner-locked transition.
- Unpublish performs both credential-family cleanups before asset deletion.
- Update, rollback, or friendly-path rename preserves the active mode's
  authority because every credential is bound to the permanent site UUID.
- Switching back to a previous private mode never resurrects revoked rows.

## Error and observability policy

- Clients receive only documented safe strings.
- Server logs may contain route name, safe error class/name, coarse outcome,
  and a correlation ID; never recipient/site/user/provider identifiers or body.
- Audit events are durable and owner-scoped but contain no email or credential.
- Product telemetry is best-effort after commit and includes only access mode
  and coarse outcome. Telemetry failure never rolls back authority.
- Health/readiness exposes a coarse capability boolean only, not which provider,
  DNS record, key, webhook, or Clerk configuration failed.

