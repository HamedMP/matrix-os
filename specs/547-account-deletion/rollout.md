# Account deletion rollout and mobile contract

The implementation is feature gated. Do not remove the existing account deletion option until the replacement page is deployed and verified. Do not enable the new flow without the required revocation and storage configuration.

## Endpoint contract

All account API endpoints require the current Clerk session JWT as `Authorization: Bearer <JWT>`. The server selects the subject; no caller-selected user ID is accepted.

| Route | Auth | Behavior |
| --- | --- | --- |
| GET /account/delete | Public | Information, Clerk sign-in, authenticated deletion/export actions |
| GET /api/account/delete | Clerk JWT | Current state |
| POST /api/account/delete | Clerk JWT | Strict `{confirm:true}`, idempotent scheduling |
| POST /api/account/delete/cancel | Clerk JWT | Strict `{confirm:true}`, cancel before grace deadline after billing finishes |
| GET /api/account/delete/export | Clerk JWT | Existing owner backup download links, bounded cursor pagination |
| GET /api/account/delete/export/platform | Clerk JWT | Personal platform account records JSON attachment |
| POST /api/account/apple-token | Clerk JWT | Strict `{code:string}` native Apple authorization capture |
| POST /webhooks/clerk/users | Svix signature | Durable acceptance of `user.deleted`; same resumable cleanup job |
| POST /billing/webhooks/stripe | Stripe signature | Existing billing processing plus cancellation of new subscriptions for pending/deleted accounts |

Scheduling returns HTTP 202 with `{status, erasesAfter, completesBy, billingStopped}`. `erasesAfter` is the five-day cancellation/export deadline. `completesBy` is a completion target (normally one day later), not a provider availability guarantee. Provider failures retry. Completed/cancelled requests return their current state; states are `none`, `scheduled`, `processing`, `completed`, `cancelled`. Errors are generic; an ownership conflict returns 409 with `code:ownership_transfer_required`.

Subscription cancellation happens immediately, without invoicing/proration or automatic refund. Cancellation of deletion never silently reactivates a subscription. Existing eligible computers retain access for five days; new checkout, provisioning, managed AI spending and backup writes are denied. Exports use existing synced backups and platform records, not an automatically generated fresh runtime dump. Export unsynced home files and fresh PostgreSQL dumps directly from the retained computer. Final storage cleanup waits one day after runtime deletion so old upload capabilities expire.

## Native mobile work

Keep native bundle ID `com.matrixos.mobile` registered under Apple team `PX4JL74Y2K`. Regenerate provisioning profiles after enabling the Sign in with Apple capability.

After native Apple sign-in authenticates the Clerk session, send Apple's one-use authorization code to `POST /api/account/apple-token`. Send the Clerk Bearer JWT and JSON `{code}`; capture before the code expires. The backend verifies the provider-issued ID token against Apple's JWKS, native audience and the Clerk user's Apple provider subject, exchanges the code and stores a user-bound encrypted refresh credential in server-only metadata. Never place the `.p8` key or client secret in the app. If a recoverable Apple credential is unavailable, account deletion still proceeds and `manualAppleRevocationRequired: true` tells clients to display [Apple’s manual access-removal instructions](https://support.apple.com/102571). Never claim automatic revocation in this case; keep these instructions visible through completion.

For account deletion, show the deadline and billing status, export/migration actions and cancellation. Request confirmation and call the same endpoint used by the web page. The account API does not require a provisioned computer.

Matching verified email addresses can link Apple sign-in to an existing Clerk account. Hide My Email creates a different address; users should link Apple from their existing signed-in account. Do not promise automatic matching between a real email and a relay alias. A random handle derived from a relay email is acceptable as an initial value; let users set a username before provisioning.

## Production configuration and sequence

1. Deploy generation-14 schema and application with `ACCOUNT_DELETION_ENABLED` unset. Configure a dedicated `ACCOUNT_DELETION_SECRET` of at least 32 bytes and preserve it in the secret manager; changing it loses both owner hashes and encrypted credentials. Back it up and rotate only through an explicit migration.
2. Configure Clerk server key, primary sync R2/S3 store settings (not bundle-store credentials), Stripe key, Pipedream, WhatsApp/voice and Matrix homeserver settings where those integrations exist. Required cleanup dependencies fail closed when owner resources need them.
3. Configure `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_SERVICES_ID`, `APPLE_NATIVE_CLIENT_ID`; all Apple fields are required together. Use the dedicated Apple signing key through the secret manager. Web Apple access tokens are retrieved again before revocation and require verified client provenance and explicit future expiry for automatic revocation; native users use their captured refresh credential. Clerk’s documented OAuth response makes identity token and expiry optional, so missing evidence uses the explicit manual fallback. Provider outages, invalid credentials, and missing configuration remain failures that require retry or repair.
4. Verify the full flow using disposable test identities and test resources. Never delete a live customer to validate it. Check repeat requests, billing cancellation, grace access, export pages, cancellation, crash/retry, all cleanup phases and tombstone erasure.
5. Enable `ACCOUNT_DELETION_ENABLED=true` with the same secret and cleanup configuration on both API-serving hosts and the platform worker host. Keep `PLATFORM_BACKGROUND_WORKERS_ENABLED=false` on Cloud Run API hosts; confirm the dedicated worker runs and drains on shutdown. Add the required production environment and secret bindings before rollout.
6. Turn off **Clerk self-deletion**, make the Matrix account menus and any hosted profile entry points point to `https://app.matrix-os.com/account/delete`, then subscribe `user.deleted` to `https://app.matrix-os.com/webhooks/clerk/users` and configure `CLERK_USER_WEBHOOK_SIGNING_SECRET`. Verify the signed endpoint responds successfully after deployment. Dashboard deletion still triggers the safety-net path.
7. Keep signed Stripe webhooks active. They cancel a new subscription created through a previously issued portal/session while a deletion job is pending. Payments already settled are not refunded automatically.

Clerk deleting an identity before the job captured its Apple credentials makes automatic revocation unknowable. The webhook still erases the account and its data, using explicit manual Apple revocation instructions rather than blocking deletion indefinitely. Captured native refresh credentials remain eligible for automatic revocation. [Apple TN3194](https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple) requires fulfilling deletion requests when revocation credentials are unavailable. Do not assume Clerk automatically revokes Apple authorization.

## Operations

Watch `[account-deletion]`, `account deletion cleanup failed`, `cleanup_retry` and pending jobs by `next_step`, `attempts`, `next_attempt_at`, `due_at` and lease age. Healthy jobs stop billing immediately, wait until `due_at`, checkpoint cleanup, then purge `encrypted_context` and retain only the keyed owner tombstone and aggregate accounting totals. Log no tokens or decrypted context.

Alert on billing cancellation pending over an hour, jobs overdue over a day, stale leases, unresolved AI accounting, missing integration config, ownership conflicts or Apple provider failures. Missing Apple revocation evidence is an explicit user-facing manual action and does not stall account erasure. Mitigate by restoring dependencies and allowing retries; disabling the feature flag on API-serving hosts leaves admission protection and tombstones active as long as the secret remains configured. Keep the worker feature enabled so retries continue. Do not roll back/drop the jobs table or remove the secret while deletion jobs are pending.

Optional Apple server-to-server notifications are deferred. The public documentation change is delivered separately in the private `FinnaAI/matrix-os-site` repository.
