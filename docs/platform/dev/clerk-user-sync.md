# Clerk user sync

Matrix OS uses Clerk as the identity source of truth. The platform `users` table is
the control-plane projection used by integrations, provisioning, billing-adjacent
workflows, and operator queries.

## New signups

New signups enter through the website Inngest `clerk/user.created` function. That
function derives a Matrix OS handle from Clerk username, primary email, or a stable
Clerk-id fallback, then calls the platform `/users/sync` endpoint with:

- `handle`
- `clerkUserId`
- `displayName`
- `email`

That endpoint only idempotently upserts the user projection. It must not provision
a VPS. The app should show billing and machine selection after signup; only the
browser-triggered `/api/auth/provision-runtime` path creates a VPS after the user
has chosen a machine and passed billing/entitlement checks.

The Inngest function keeps the existing `provision-matrix-os` ID for queued-run
continuity. Its current behavior is sync-only despite the legacy ID name.

## Backfill existing Clerk users

Dry-run first:

```bash
CLERK_SECRET_KEY=... \
PLATFORM_DATABASE_URL=... \
pnpm exec tsx scripts/backfill-clerk-users.ts --dry-run --quiet
```

Apply after reviewing the dry-run count:

```bash
CLERK_SECRET_KEY=... \
PLATFORM_DATABASE_URL=... \
pnpm exec tsx scripts/backfill-clerk-users.ts --apply --quiet
```

The script pages through Clerk users, derives collision-safe handles, and writes
through the same `ensurePlatformUser` upsert helper as signup sync. It does not
print secrets or provision runtimes.

## Verify

```sql
select count(*) from users;
select clerk_id, handle, email, status from users order by created_at desc limit 20;
```

Then create a test signup and verify:

1. Inngest receives the `clerk/user.created` event.
2. `/users/sync` succeeds.
3. `users` contains the new `clerk_id`.
4. `user_machines` does not gain a row until the user chooses a machine and
   completes the billing-gated provisioning flow.
