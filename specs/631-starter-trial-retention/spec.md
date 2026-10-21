# Starter trial and unpaid runtime retention

Starter receives a fourteen-day card-required trial. Builder and Max retain their three-day trial duration. Existing checkout promises are preserved. Public trial/retention documentation and Terms live in the separate private site repository and ship with its own PR.

## Unpaid trial retention policy

An unpaid trial runtime may be permanently deleted seven days after its authoritative Stripe trial end. Deletion erases the VM and its local runtime data; it does not close the Matrix account. This is a minimum retention window, not an automatic deletion schedule or a backup guarantee. Checkout and public documentation must disclose this policy.

This release adds an operator workflow only. It does not enroll historic customers or automatically sweep machines. Existing machines are review-only until an operator has reviewed each exact machine and attested to prior notice at least seven days earlier. Updating Terms alone is insufficient evidence of notice for historic users. No email is sent by the workflow.

## Reviewed cleanup

1. Run the operator inventory against the authenticated platform database. It is bounded to 50 private candidate records, read-only, and never runs migrations. It prints no IPs, email addresses, credentials, or runtime data. Keep the inventory and exact-target review outside the repository in private storage.
2. Confirm the user received notice of permanent VM/data deletion and had at least seven days to recover or export data. Record the notice time/reference and an authorization reference in a protected exact-target review. Review at most five owners at once.
3. Dry-run the review. A fresh five-minute review window and exact machine/server/subscription IDs are mandatory. The resulting fingerprint includes current billing, entitlement, override, provider identity, and machine state. Candidate inventory alone never authorizes deletion.
4. After reviewing the fingerprint, apply that exact review with the explicit apply flag, fingerprint, and a new protected journal path. Any change to eligibility or the reviewed database snapshot refuses the operation. All machine tombstones and provider deletion intents commit in one transaction, or none do.
5. The existing provider deletion worker performs idempotent deletion of the exact server IDs. A queued result means deletion has been scheduled, not confirmed. Verify provider disappearance and queue completion before declaring cost reclamation complete. A pending journal or unknown commit must be reconciled before retrying.

The command is `bun scripts/ops/cleanup-expired-trials.ts --inventory`, or the same command with a protected review JSON path for dry-run. Apply additionally requires `--apply --reviewed-sha256 <reviewed fingerprint> --journal <new private journal path>`. It requires configured platform DB access and read-only provider verification credentials. Never paste secret values into tickets or public documentation.

The protected review is a strict JSON object with `version: 1`, `sourceSha` (the clean reviewed commit), `authorizationReference`, `issuedAt`, `expiresAt` (at most five minutes after issue), and `targets`. Each exact target contains `ownerId`, `machineId` (UUID), `serverId` (positive integer), `subscriptionId`, `noticeGivenAt`, and `noticeReference`. Dates use ISO timestamps with offsets; notice and authorization references are bounded operator references, not free-form customer correspondence. Files must be owned by the operator/root, mode `0600`, without symlinks or multiple hard links, under trusted directories. Keep credentials in the operator environment, never in the review or command arguments. `PLATFORM_DATABASE_URL` must use verified TLS for remote connections; provider reads require `STRIPE_SECRET_KEY` and `HETZNER_API_TOKEN`. Include the deployed account-deletion secret when that feature is enabled; an unknown deletion namespace fails closed.

The platform revision that implements the shared billing-owner lock must be deployed and verified before any live apply. After a fresh authenticated check of all serving revisions, the operator must set `MATRIX_TRIAL_RETENTION_DEPLOYED_SOURCE_SHA` to the reviewed source SHA; apply refuses a missing/different attestation. This is an operator attestation, not automatic deployment proof. A clean local checkout alone does not prove that concurrent serving revisions honor that lock. Never apply during a mixed deployment with earlier revisions.

## Eligibility and concurrency

Only a suspended, non-deleted, customer primary VM with a uniquely matched provider server and exact Matrix labels is eligible. Its subscription must have authoritative trial dates, be canceled, have no conversion, and be at least seven days past trial end. Never delete a recoverable unpaid/past-due subscription, a running VM, preview, recovery/resize operation, or a runtime with pending billing actions.

All subscription history for the owner must be terminal and never converted. Paid history, purchased AI credits, an in-progress checkout, active/internal entitlement, live override, alternate active subscription, identity mismatch, pending account deletion, provider uncertainty, changed trial end, and incomplete provider pagination fail closed. Live Stripe verification checks all bounded owner customer subscriptions and invoices: any paid amount, open, draft, or uncollectible invoice excludes deletion. The live Hetzner server must be powered off and match the exact machine/owner/slot.

Account-deletion admission, billing owner advisory locks, and locked billing/machine rows serialize the final eligibility decision with subscription creation, payment recovery projection, and override insertion. The billing lock exists even when account deletion is disabled. Database reads after waiting use READ COMMITTED; exact resource predicates remain in the write. Reflection of a payment before the commit prevents deletion. Stripe and Hetzner do not share a transaction with Postgres: once the reviewed deletion intent commits, later external activity cannot restore the old VM. Subsequent purchases must provision a new VM. Operators must not coordinate an apply with independent administrative billing SQL outside these locks.

## Security and verification

No endpoints or cron jobs are added; the auth boundary is existing private operator DB/provider access plus exact-target review, notice attestation, fingerprint bound to the clean reviewed source SHA, and protected append-only journal. Batches are capped at five owners; owner histories at 128 rows; inventory at 100 maximum. Locks, SQL, and provider calls have bounded timeouts. Operator connections own and close their pools; transaction wrappers do not.

Test red first, then verify inventory/dry-run non-mutation, exact identity/fingerprint guards, expired notice and grace periods, newly paid/recovered owners, paid history in alternate slots, pending purchases, purchased AI credits, override exclusion, provider failure/pagination, zero-cost trial invoice handling, atomic queue/tombstone writes, and retained account records. `tests/platform/trial-retention-postgres.test.ts` additionally requires `MATRIX_TEST_POSTGRES_URL` pointing at a disposable PostgreSQL database; it creates/drops isolated synthetic schemas and verifies real advisory-lock contention with payment, override, subscription, and checkout writers. No live customer deletion is part of automated tests or this implementation task.

## Plan-aware trial rollout

`MATRIX_STARTER_TRIAL_DAYS` defaults to `14`; `MATRIX_CARD_TRIAL_DAYS` remains
`3` for Builder and Max. Both settings accept integers from 1 through 30 and
are validated before routes start and during production/preview deployment.
The existing global rollout flag and once-per-account primary-slot eligibility
remain authoritative. The active Checkout attempt's duration, including an
immediate-payment null value, wins over changed configuration on retries.

Installed native clients strictly parse the original billing-status response.
`GET /billing/status` therefore retains the legacy two-field trial offer by
default. Upgraded clients request `trialOfferVersion=2` to receive the bounded
plan list and duration map, then use the shared contract helper for the selected
plan. Unknown versions fail boundary validation. Older clients can understate
the Starter duration in their summary; Stripe Checkout confirms the actual
promised duration before acceptance.

Deploy the compatible platform revision first, then the new Web/Electron/Mobile
clients and public website offer. A new client requires the v2-capable platform;
do not deploy it against an old platform that rejects the version query. The
website changes are tracked in FinnaAI/matrix-os-site PR #266. Verify Starter's
14-day Checkout, Builder/Max's three-day Checkout, additional-computer immediate
billing, and existing reserved offers before presenting the new offer publicly.
