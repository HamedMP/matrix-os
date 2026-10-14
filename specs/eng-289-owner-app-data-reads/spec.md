# ENG-289: bounded owner app-data reads

## Goal and scope
Owner-authorized personal Claude Chat runs discover granted app schemas and read records without database or machine credentials. No SQL console, app writes/DDL/provisioning, cross-owner/app access, new database/ORM, credential export, or ENG-290 preview sessions. Security/product owner review is recommended. No renderer/UI changes; shared core tool semantics apply across Chat surfaces. Live owner-run/surface qualification must be recorded separately; local tests are not visual evidence.

## Auth matrix
| Route/tool | Authority | Public |
| --- | --- | --- |
| POST /api/agent/app-data/read; read_app_data | Live server-issued owner/run/runtime grant with installed app/storage schema/declared-table snapshot | No |
| Existing /api/bridge/query | Existing policy, never admitted by the read grant | No |

Only exact method/path is authorized. Reject machine bearers, identity-header forgery, unscoped/revoked/expired tokens and client authority overrides. Personal owner and runtime are verified at issuance and request time; shared/Preview gets no grants. Grant is copied and rechecked after asynchronous work. No credential-bearing fallback.

## Validation and limits
Strict Zod 4 action union: listApps, schema, find. Only safe identifiers and declared columns/operators; unknown keys, SQL and mutations fail closed. Hono bodyLimit before JSON parsing: 16 KiB. Default 50/max 100 rows, at most 64 apps/32 tables, 16 filter/order fields, 100 in-values, 2 KiB string filters, bounded offset (10000), id tie-breaker for deterministic pagination. Response including metadata: at most 64 KiB UTF-8. Runtime SQL checks size before transferring record values and runs read-only with 5s statement timeout; network tools have 10s deadline. No unbounded worker buffers/maps; existing capability registry has 128 active grants and 35-minute TTL/revocation.

## Runtime wiring
Startup constructs read services only with owner DB/Kysely, registry and runtime identity. It provisions audit storage once, registers a dedicated route and auth verifier, supplies run-grant resolution to native Claude, and exposes a registered MCP tool. Validate dependencies at registration; no global communication. Source of truth is the owner Postgres database and current installed app registry. Server-derived installed-app grants are snapshots, intersected with current declared schema at every read. Only declared columns are selected. Large server.ts changes stay composition-only; new behavior belongs in focused modules.

## Failure/atomicity/audit
Read-only query transaction owns statement timeout; no network inside. Audit success before returning records; failure to persist audit fails closed. Persist bounded authority/outcome metadata, never raw records/tokens/SQL/error text, with retention capped at 10000 audit entries. Audit writes are security logging, never app mutations. Denials use generic 400/401/403/413; dependency/query/audit failures 503. Empty results remain 200. Revalidate grant after awaited registry/query/audit steps so revocation during a read prevents output. Destroy only owned pools on shutdown (existing DB lifecycle).

## Acceptance and docs
Red→Green real MCP/Hono/capability/Kysely/Postgres fixtures: five sorted records, schema grant intersection, default/max/pagination, byte/body caps, forged identity, cross owner/runtime/app/table, SQL/write rejection, no provisioning, safe unavailable errors, audit, expiry/revocation including in-flight reads. Add registration/startup wiring and dependency validation tests. Run typecheck, patterns and affected suites; Greptile 5/5 then ready-for-ci and passing triggered CI; never merge without authorization.

Public docs deliverable: separate PR in FinnaAI/matrix-os-site under content/docs documenting read tool availability, scopes/limits, errors and exclusions. No public credentials/private runtime evidence. Implementation readiness and live evidence gaps remain explicit.
