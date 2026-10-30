# Pre-publication request qualification

Tracking: [ENG-418](https://linear.app/matrix-os/issue/ENG-418).
Native stack: <https://github.com/HamedMP/matrix-os/stack/3026>.

This layer supplies the durable request and early authorization boundary needed
before protected publication. It does not implement publication, cloud retirement,
the local launcher or live collaboration acceptance. T016/T033 remain incomplete.
No VPS, cloud revision, deployment, membership or sharing permission was changed.

## Named faults and results

- Actual `admitPreviewPair` and `requestPreviewPairUpdate` both accepted a candidate
  without its prior source-owned publication intent. Both intended assertions
  failed first (promises resolved instead of rejecting); both pass with the
  transaction fence.
- The actual operator HTTP router returned404 for a verified preparation request.
  One selected regression failed with `expected404 to be202` against the original
  router, then passes against the implemented router/service/database path.
- Sequential focused qualification: **42 tests /5 suites passed, exit0**, with no
  skipped assertions or unhandled errors.40 assertions use actual Postgres across
  intents, request routes, service and controller;2 exercise actual startup
  migrations through the retained PGlite test adapter.
- Coverage includes exact immutable controller/requester/source/profile binding,
  no machine/job/provider creation during preparation, bounded capacity,
  non-extending replay/expiry, cancellation before adoption, idempotent adopted
  replay, concurrent cancellation/admission, rollback of adoption with the
  canonical generation, and independently verified maintainer updates.
- New suites are in the strict real-Postgres inventory (**82 files**); discovery
  rejects missing or stale entries rather than silently skipping them.
- All **8 native typecheck projects passed, exit0**.
- Pattern scanner: **0 violations,3 reviewed warning categories**, exit0. All
  operator JSON reads follow the shared16KiB streaming body limit. The fixture
  set is bounded by existing8-item inventory checks. Other set/identifier hits
  come from unchanged legacy helpers in `db.ts`, scanned because its table-type
  registration changed; this layer introduces no behavior in those helpers.
- The old exact-schema baseline failed on the intended newly added table. Capture
  from disposable PostgreSQL16 adds only its12 columns,11 constraints and2 indexes;
  every previously captured table/column/constraint/index is retained unchanged.
- Retained qualification: **41 tests /4 suites passed, exit0**, no skips/errors:
  full schema foundation, platform migration/revision, WhatsApp startup and
  existing pair HTTP contracts. This includes the actual-Postgres upgrade/schema
  union check alongside retained PGlite migration and HTTP fixture coverage.

Two earlier overlapping local runs hit the fixture's global migration lock
timeout. These were invalid fixture failures and are not counted as regression
evidence or passing qualification. The42-test result comes from one sequential
runner with the actual-server assertions on task-owned disposable Postgres.

## Boundary and invariants

The real operator router, service orchestration, migration, Kysely transaction
scope and Postgres admission/update writes remain connected. External controller,
identity, source and provider observations use explicit test ports in these
suites; this does not establish effective live IAM, a published revision or a
working owner/member Chat journey. Existing reader/issuer/source-boundary suites
remain in the stack; no candidate-provided authority replaces them.

The early route verifies the current reviewed controller and maintainer, test
identity/funding prerequisites and actual target-isolation gate before recording
the request. Production startup supplies the server-derived profile fingerprint;
HTTP cannot choose it or supply actor, issuer, secret bindings or arbitrary URLs.

Related adoption/generation/member/job writes share the existing admission lock
and transaction; update uses that lock too. Cancellation is serialized on the same
boundary. An adopted request is owned by the canonical pair's lifecycle and cannot
be stopped through the request-cancellation endpoint. An unadopted cancelled or
expired request retains capacity until independent retirement is proved. A new
attempt cannot reuse its UUID/generation or extend its publication window.

The schema migration is independently versioned at pair generation3 and remains
default disabled through existing source startup configuration. It introduces no
customer provisioning, account/org state system, directory publication or grants.

## Remaining qualification

Cloud retirement and protected automation follow in the next stack layer. The
complete required Postgres lane, production shell/Electron builds, paired native
process E2E and reviewed exact-target live evidence remain feature-level work.
This headless change provides no rendered Web Desktop or Electron Desktop
evidence and does not qualify either surface. Current-head Greptile and applicable
CI remain required; no merge or deployment is authorized.
