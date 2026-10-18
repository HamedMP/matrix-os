# Consent-aware Reddit attribution

Tracking: [ENG-159](https://linear.app/matrix-os/issue/ENG-159/implement-and-reconcile-the-launch-activation-and-paid-cohort).

## Goal and observed gaps

Improve trustworthy attribution without changing campaign creative, targeting, or the two $40 lifetime budgets. The PageVisit score is a browser-event diagnostic, not proof that paid users are unattributed. Organic visits need not contain a Reddit click ID. A server-side customer identifier does not increase the score of unrelated anonymous browser page views.

Existing website capture waits for explicit marketing acceptance and forwards allowlisted campaign parameters to app signup. App capture currently persists campaigns indefinitely without checking that existing shared choice. Stripe CAPI currently sends trial/payment events even without recorded advertising consent. CAPI SIGN_UP means a completed zero-value subscription checkout, not Clerk account creation. PURCHASE means positive collected invoice or one-time payment; immediate subscription Checkout is ignored to prevent a duplicate invoice purchase.

## This change

- Reuse the current shared marketing consent cookie/local choice; reject missing, malformed, expired and rejected choices. No new consent UI.
- Preserve exact bounded Reddit click IDs; reject oversized IDs rather than truncating into a different identifier.
- Persist the app campaign for at most 30 days and no longer than the consent's expiry. New campaigns replace previous campaigns atomically. Do not migrate old indefinite snapshots.
- Carry acceptance plus expiry into Checkout and Stripe metadata. CAPI ignores events without currently valid consent proof. Historical checkouts without proof are intentionally skipped; missing ad attribution never means no real purchase.
- Expired or rejected optional consent metadata is dropped without blocking payment. Keep existing conversion IDs and revenue semantics. Do not introduce browser conversion events, so no new Pixel/CAPI duplicates.
- Sanitize conversion source URLs to marketing allowlisted query keys; a metadata click ID is the exact source of truth for rdt_cid.

## Auth, data and boundaries

No new routes, credentials or permissions. Checkout retains existing authenticated Clerk identity and body/schema validation; Stripe webhooks retain signature verification. Consent fields are client assertions bounded by checkout validation, never authentication. A dedicated Postgres snapshot table binds the original marketing payload (including absence) to its authenticated owner and Checkout attempt. Insert-on-conflict/select occurs in one transaction. The snapshot is immutable across ambiguous Stripe retries, purged after seven days by the existing periodic tracking-retention worker, cascades with attempt deletion and participates in account erasure. No new persistence system. Metadata writes remain part of the existing idempotent Checkout creation. CAPI's outbound timeout remains 10 seconds.

No new email, phone, IP, user-agent or UUID sharing. No live Reddit switches, tags, tokens, account access, campaigns or production runtime changes. No replaying historical events. Revoking the shared browser choice stops future app capture; deletion of previously sent Reddit data is a separate existing data-subject process. A consent snapshot in Stripe cannot observe later revocation while an offline invoice webhook runs; server-authoritative revocation is required before expanding signals.

## Follow-up requiring explicit approval

1. Confirm live GTM PageVisit emits only after current acceptance, and inspect an actual ad-generated click ID through redirect, signup, Checkout and CAPI in Reddit test mode. Do not generate production billing or fabricated ad traffic.
2. Add a server-authoritative owner consent ledger and revocation propagation before broader user matching.
3. If approved, collect the real client IP from a verified ingress boundary and the browser UA at the actual conversion request. Never use a webhook server IP or blindly trust forwarded headers.
4. If approved, share the Pixel's existing UUID through the same consented handoff; do not manufacture a parallel identifier. Use a single per-event conversion ID when the same event is sent through Pixel and CAPI.
5. If approved, use the owner's verified email and Reddit's current canonicalization plus SHA-256. Hashing is pseudonymization, not anonymization. Do not collect phone numbers to chase a score.

## Review fixes and extraction boundary

Regression cases cover changing, absent and expired consent during an ambiguous Stripe response; legacy local-storage cleanup with a new campaign; and normalized double-slash paths retaining the checked source origin. The existing large billing route receives only the snapshot-helper orchestration call. Before adding further Checkout behavior, extract the claim/recovery/Stripe orchestration into a focused service and move its retry cases into a dedicated integration suite; do not continue growing the route container. The new persistence helper is already isolated.

## Validation and delivery

Tests must cover no consent, rejection, expiry, blocked storage, new campaign replacement, exact click ID, legacy snapshots, Checkout metadata, positive payment/trial semantics and unchanged retry conversion IDs. No visual UI change: renderer screenshot parity is not claimed; inspect consented browser behavior separately before release. Recommend engineering/privacy-owner review of the consent behavior. Existing requester authorizes implementation, not additional external signal activation.

Separate site-repository documentation PR is an explicit deliverable: update canonical tracking/billing docs with consent expiry, click-ID retention, trial SIGN_UP semantics and verification limitations. Keep private account metrics out of public documentation.

Primary references: [Reddit direct integration](https://ads-api.reddit.com/docs/v3/guides/programs/capi/direct-integration), [click-ID persistence](https://ads-api.reddit.com/docs/v3/guides/programs/capi/click-id-persistence), [best practices](https://ads-api.reddit.com/docs/v3/guides/programs/capi/best-practices).
