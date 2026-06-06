# Clerk user sync

Matrix OS uses Clerk as the identity source of truth. The platform `users` table is
the control-plane projection used by integrations, provisioning, billing-adjacent
workflows, and operator queries.

## New signups

New signups enter through the website Inngest `clerk/user.created` function. That
function derives a Matrix OS handle from Clerk username, primary email, or a stable
Clerk-id fallback, then calls the platform `/containers/provision` endpoint with:

- `handle`
- `clerkUserId`
- `displayName`
- `email`

The platform endpoint provisions the runtime and idempotently upserts the user row
after the runtime request succeeds. Browser-triggered `/api/auth/provision-runtime`
uses the same platform-side upsert path.

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
through the same `ensurePlatformUser` upsert helper as provisioning. It does not
print secrets.

## Verify

```sql
select count(*) from users;
select clerk_id, handle, email, status from users order by created_at desc limit 20;
```

Then create a test signup and verify:

1. Inngest receives the `clerk/user.created` event.
2. `/containers/provision` returns `202` for VPS runtime or `201` for legacy local runtime.
3. `users` contains the new `clerk_id`.
4. `user_machines` contains the active VPS row for that `clerk_user_id`.
