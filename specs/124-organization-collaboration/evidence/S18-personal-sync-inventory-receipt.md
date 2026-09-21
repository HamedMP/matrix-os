# S18 / T102 follow-up receipt — personal sync grant inventory

**Date:** 2026-09-21. **Base:** corrected pre-T090 ancestry `e5392e052`. **Branch:** `124/s18-personal-sync-inventory`. **RED test commit:** `cbc6d51cb`. **GREEN code commit:** `51e4e92f5`. Local layer only; no push, PR, merge or deployment.

## Scope and invariants

- `scripts/collaboration/inventory-person-to-person.ts` retains its existing `gateway` and `platform` collaboration counters. It adds a separate top-level `personalSync` field for the owner database. If the gateway URL is omitted, that field is `null`; if `sync_shares` is absent, it is `{ state: "missing" }`, which is distinct from a migrated empty table reporting zero counts.
- The fixed read-only query returns persisted total, pending, accepted and expired-subset counts. No actor ID, path or grant row leaves the database. An expired grant remains in the total and its accepted/pending group; `expiredGrants` is an overlapping subset.
- Source of truth: the existing `sync_shares` table in the owner Postgres, kept separate from organization collaboration scopes and cutover journals. The operator script is credentialed by its database URL; this change adds no HTTP route or authorization path. No migration, table write, transaction boundary, lock, schema or rollback state changed. S18 will neither import nor delete these personal grants.

## RED → GREEN

| Gate | Observed result |
| --- | --- |
| Initial RED `pnpm exec vitest run tests/gateway/personal-sync-share-inventory-postgres.test.ts --maxWorkers=2` | Import failed because `packages/gateway/src/sync/share-inventory.ts` did not exist; no tests executed. |
| Behavioral RED with a minimal missing-state stub and the dedicated real Postgres URL | 1 failed: after `migrateSyncTables`, `{ state: "missing" }` was returned where the fixture expected a present empty table with four zero counts. |
| GREEN `set -a; source /tmp/matrix-os-124-postgres.env; set +a; pnpm exec vitest run tests/gateway/personal-sync-share-inventory-postgres.test.ts --maxWorkers=2` | 1 file, 1/1 passed on an isolated real-Postgres schema. Missing, empty and three-grant states passed. The test ran the actual operator script in a child process and asserted `gateway.total: 0`, `platform: null`, and `personalSync: { state: "present", totalGrants: 3, pendingGrants: 1, acceptedGrants: 2, expiredGrants: 1 }`. Source rows remained present after inventory. |
| Static gates | `pnpm exec tsc --noEmit -p packages/gateway/tsconfig.json`: exit 0. `bun run check:patterns`: 0 violations, 5 existing warnings. `git diff --check`: exit 0. |

**Production evidence:** unrun. The local three-grant fixture is not a claim about any customer home. An operator with approved access must run the script against the actual owner database before relying on its counts. Personal sync grants and existing CLI behavior remain outside organization cutover disposition. No live rollback was exercised; removing this read-only field restores the prior operator JSON without changing grants.
