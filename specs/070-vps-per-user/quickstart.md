# Quickstart: VPS-per-User Architecture

This guide is for implementing and validating phase 1 in a development worktree.

## 1. Environment

Required local tools:

```bash
pnpm install
bun --version
node --version
```

Required control-plane environment for real provisioning:

```bash
HETZNER_API_TOKEN=...
HETZNER_CUSTOMER_PROJECT=matrix-os-customers
HETZNER_LOCATION=nbg1
HETZNER_SERVER_TYPE=cpx21
HETZNER_SSH_KEY_NAME=matrix-ops
PLATFORM_SECRET=...
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET=matrixos-sync
```

Do not run real Hetzner tests without an explicit opt-in env flag in the test command.

## 2. Test-First Checklist

Write failing tests before implementation for:

```text
tests/platform/customer-vps.test.ts
tests/platform/customer-vps-routes.test.ts
tests/platform/customer-vps-cloud-init.test.ts
tests/platform/profile-routing-vps.test.ts
```

Minimum assertions:

- `/vps/provision` is idempotent by `clerkUserId`.
- Mutating routes reject bodies over 4096 bytes.
- Invalid platform secret and invalid registration token fail closed.
- Registration consumes token and clears token fields.
- Hetzner/R2 errors map to generic client errors.
- Cloud-init render includes required variables and does not leak secrets to logs.
- Routing prefers `userMachines.running` and falls back to legacy `containers`.
- Recovery refuses missing `system/db/latest` unless `allowEmpty` is true.

## 3. Local Verification

Run focused tests:

```bash
bun run test tests/platform/customer-vps.test.ts
bun run test tests/platform/customer-vps-routes.test.ts
bun run test tests/platform/profile-routing-vps.test.ts
```

Run standard pre-PR checks:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

## 4. Manual Real-Hetzner Smoke

Only after mocked tests pass:

```bash
bun run dev:platform
curl -sS -X POST http://localhost:9000/vps/provision \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"clerkUserId":"user_test_vps","handle":"vps-test"}'
```

Expected:

1. Response is `202` with `status: "provisioning"`.
2. Hetzner server appears in the customer project.
3. Server calls `/vps/register`.
4. `GET /vps/:machineId/status` returns `running`.
5. R2 contains `system/vps-meta.json`.

Tear down explicitly:

```bash
curl -sS -X DELETE http://localhost:9000/vps/$MACHINE_ID \
  -H "Authorization: Bearer $PLATFORM_SECRET"
```

Never use `docker compose down -v` as part of this feature unless intentionally resetting local state.

## 5. Recovery Smoke

After backup phase is implemented:

```bash
curl -sS -X POST http://localhost:9000/vps/recover \
  -H "Authorization: Bearer $PLATFORM_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"clerkUserId":"user_test_vps"}'
```

Expected:

- Existing server is deleted or marked replaced.
- New server boots with a new `machineId`.
- Restore completes before gateway starts.
- Status returns `running`.
- User files and Postgres sanity query match pre-recovery state.

## 6. Documentation Deliverable

Implementation tasks must include public docs at:

```text
www/content/docs/deployment/vps-per-user.mdx
```

Docs must include:

- Phase 1 scope and non-goals
- Cost model and Hetzner quota note
- Backup retention
- Manual recovery steps
- Restored vs not restored state
- Rollback path to legacy container routing for non-migrated users
