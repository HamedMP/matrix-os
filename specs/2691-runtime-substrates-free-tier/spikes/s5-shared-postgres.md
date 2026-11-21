# S5: per-owner role and database on a shared Postgres, direct vs PgBouncer

**Verdict: partial pass.** The gateway boots against a role with no superuser and `CONNECTION LIMIT 5`, and every migration runs. Under load it stays within the limit with no connection-limit errors, no deadlocks and no session-lock breakage. A full chat turn was not exercised. Turn admission returns `provider_unavailable` before any model call, because no provider is configured. Chat create, list and read (database work) were exercised. One code change was needed, because the default pool fails under load.

What ran: 400 mixed bridge requests per run (40 at a time; key-value store, insert, find, count), 40 parallel chat creates, 80 chat reads, and a steady 4-worker load during credential rotation. Not exercised: browser approvals (behind a feature flag), the bots and Slack routes, and a funded chat turn.

Versions: Postgres 16.15 (`postgres:16-alpine`, same major as the repo), PgBouncer 1.24.1 (`edoburu/pgbouncer:v1.24.1-p1`) in transaction mode.

## Inventory

| Item | Where | Scope | Transaction-mode pooler |
| --- | --- | --- | --- |
| `pg_advisory_xact_lock` / `_shared` (about 30 sites) | bots/*, chat/*, slack/*, jev/*, sites/submission-repository.ts:19, sync/db-impl.ts:145, company-brain/database.ts:38, collaboration/resource-catalog.ts:211 | transaction | Safe (tested) |
| Session advisory locks, `LISTEN`/`NOTIFY`, temp tables, `PREPARE`, named statements | none found | n/a | n/a |
| `SET LOCAL` and `set_config(...,true)` timeouts | chat/*, sites, sync/db-impl.ts:144, organization-drive/service.ts:78 | transaction | Safe (tested) |
| `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout` passed as connection settings | jev/owned-maintenance.ts:26, sites/bootstrap.ts:9, chat/browser-approval-owned-runtime.ts:18 | session | **Breaks:** PgBouncer refuses the connection |
| `CREATE SCHEMA` (one schema per app) | app-db.ts:112 | DDL | Needs `CREATE` on the database |
| plpgsql functions and triggers | bots/database-migrations.ts:34, chat/managed-pi-migration.ts:7 | DDL | Needs only `CREATE` on schema `public` |
| `gen_random_uuid`, `to_tsvector` | platform-db.ts, social.ts, bots | built in | No extension needed |
| `CREATE DATABASE` / `CREATE ROLE`, superuser calls, cross-database queries | none in the gateway | n/a | n/a |

The kernel package and the other packages the gateway loads do not use pg or Kysely.

| Pool | max | When |
| --- | --- | --- |
| app-db.ts:57 (shared Kysely for chat, canvas, bots, collaboration…) | 10 | always |
| jev/owned-maintenance.ts:21 | 1 | always when `DATABASE_URL` is set |
| sites/bootstrap.ts:7 | 1 | at boot only |
| chat/browser-approval-owned-runtime.ts:17 | 2 | feature flag only |
| platform-db.ts:259 | 10 | needs `PLATFORM_DATABASE_URL`, never set on an owner runtime |

With defaults, one gateway can open up to 12 connections at boot and 13 at peak (14 counting the brief boot pool). With the owner pool at 3, the observed peak was **4**. Idle connections drop to 0 after about 10 s.

## Direct vs pooler

- **Direct, pool 3:** 0 errors across all runs. With the default pool of 10, the same burst gave 229/400 errors (500) and 36/40 chat-create errors (503), all `too many connections for role`.
- **PgBouncer:** the bridge and chat burst had 0 errors. But the Jev maintenance pool and the sites setup pool were refused (`unsupported startup parameter: statement_timeout`), so `_site_submissions` was never created. As a control, a session advisory lock was acquired by a second client and then leaked on a pooled backend, and a session `SET` showed up for another client. `SET LOCAL`, transaction advisory locks and named prepared statements worked. PgBouncer's server connections also count against the role's limit of 5, which blocked direct access as the same role.
- **Fencing:**
  - Direct: `ALTER ROLE … PASSWORD` alone let the old gateway keep writing for 15 s. Adding `pg_terminate_backend` cut it off at once, and every later request failed with `password authentication failed`.
  - PgBouncer: with the new password in the PgBouncer user list, a reload, and the role's backends terminated, the old gateway still got about 50% of requests through for 30 s (its sockets to PgBouncer survive), until PgBouncer `KILL` was run.
  - In both cases the fenced gateway stays up and `/health` still reports `ok`.

**Recommendation: no pooler.** The only client is one single-owner gateway that already pools. A pooler breaks two startup pools, weakens fencing, and uses up the role limit. Add one only if cluster `max_connections` becomes the binding limit (default 100 minus 3 reserved, so about 19 concurrently active owners at 5 each), after fixing the three connection-setting sites.

## SQL

Provision (run as admin; committed as `spike/2691-s5/provision-owner.sql`):

```sql
CREATE ROLE :"owner" LOGIN PASSWORD :pw
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
  CONNECTION LIMIT 5;
CREATE DATABASE :"owner" OWNER postgres;
ALTER DATABASE :"owner" CONNECTION LIMIT 5;
REVOKE ALL ON DATABASE :"owner" FROM PUBLIC;
GRANT CONNECT, CREATE ON DATABASE :"owner" TO :"owner";
ALTER ROLE :"owner" SET statement_timeout = '30s';
ALTER ROLE :"owner" SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE :"owner" SET lock_timeout = '10s';
ALTER ROLE :"owner" SET temp_file_limit = '256MB';
\connect :"owner"
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"owner";
```

Once per cluster: `REVOKE CONNECT ON DATABASE postgres, template1 FROM PUBLIC`. Without that, owners could connect to both.

Deprovision (`deprovision-owner.sql`):

```sql
ALTER ROLE :"owner" NOLOGIN;
REVOKE CONNECT ON DATABASE :"owner" FROM :"owner";
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = :'owner' OR datname = :'owner';
DROP DATABASE IF EXISTS :"owner" WITH (FORCE);
DROP ROLE IF EXISTS :"owner";
```

Minimum grants, verified on owner C: `CONNECT, CREATE` on the database and `USAGE, CREATE` on schema `public`. No `TEMPORARY`, no database or schema ownership, no superuser. Fencing: `ALTER ROLE … PASSWORD`, then `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = …`. The admin needs `pg_signal_backend` for that.

Not verified: setting `temp_file_limit` as a role default needs superuser, or `GRANT SET ON PARAMETER` on PG15+. A managed provider's admin role may not have either.

## What the platform must enforce

- **Size cap:** Postgres has none. Owner B filled the shared volume until "No space left on device", which affects every tenant. Measure `pg_database_size` and fence (stop the container or set the role to `NOLOGIN`), and keep disk headroom. The owner owns its tables, so revoking privileges on them is not an effective write block.
- **Statement timeout:** the role defaults are only defaults. The owner ran `SET statement_timeout=0` and even `ALTER ROLE self SET statement_timeout=0`, then held a 35 s query. `temp_file_limit` is enforced and cannot be overridden by the owner. The 30 s default also applies to the gateway's own long operations (imports, exports).
- **CPU:** no per-role limit. Connections per role and per database are enforced. The owner cannot raise either limit, cannot `ALTER DATABASE` or drop it, and cannot read files.
- **Visible to other owners:** all database names, role names and role settings, plus other owners' `pg_stat_activity` username, database and pid (query text hidden), and `pg_stat_database` counters. Hidden: other owners' sizes, password hashes, file access, and terminating other owners' sessions. So names must be opaque, not handles or Clerk IDs.
- **Advisory lock keys** are per database, so fixed keys do not collide across owners.
- **Trusted extensions** (such as `pgcrypto`) can be created by an owner; untrusted ones (`dblink`) cannot.

## Code changes for production

1. `packages/gateway/src/app-db.ts`: a configurable pool size (the spike adds `MATRIX_OWNER_DB_POOL_MAX`). Better: one connection budget that covers app-db + Jev 1 + sites 1 at boot + browser approvals 2, kept at or below the role limit.
2. `startup/owner-database.ts`: a container must fail closed. With rejected credentials the gateway falls back to file storage, reports `/health` ok and accepts key-value writes. That is a split-brain risk. `server/operational-routes.ts` `/health` should report database readiness.
3. If a pooler is ever added: move the connection-setting timeouts in `jev/owned-maintenance.ts`, `sites/bootstrap.ts` and `chat/browser-approval-owned-runtime.ts` to `SET LOCAL` or role defaults, and make fencing run `KILL`.
4. Leave `app-runtime/process-manager.ts` `appDatabaseUrlResolver` unwired for containers. Postgres-backed apps would need their own connection budget.
5. The legacy `packages/platform/src/orchestrator.ts` provisioning sets no connection limit, makes the owner the database owner, grants `TEMPORARY`, drops the database without terminating sessions, and names the database and role after the handle. Do not reuse it as is.

**Doc edits:**
- In `data-model.md` `container_owner_databases`: opaque `database_name`/`role_name`; add `connection_limit`, `size_limit_bytes`, `size_measured_at` and a state.
- Note that `password_epoch` rotation must terminate the role's sessions.
- In `spec.md`, the "statement timeout, size quota" line overstates what Postgres enforces: the timeout is a default the owner can override, and there is no size quota.
- In `plan.md` B4: add a connection budget and fail-closed boot.
- In `research.md` R6: record the "no pooler" decision.

## Reproduce and cleanup

Commit `cb999dae69` on `spike/2691-s5`, not pushed. Commands are in `/Users/hamed/dev/claude-tools/matrix-os-2691-spike-s5/spike/2691-s5/NOTES.md`. The containers `mx2691-s5-pg` and `mx2691-s5-pgbouncer`, the volume `mx2691-s5-pgdata` and the network `mx2691-s5-net` have been removed and confirmed gone, and no spike gateways are still running.

The disk-fill test hit the limit of the shared OrbStack VM disk. It recovered on rollback (503 MB free afterwards) and the volume is now deleted, but other containers on that VM briefly had no free space.
