# Managed backend and versioned clients

## Product contract

Platform, gateway/kernel and hosted web shell are an automatically maintained backend. Desktop and mobile have independent supported version ranges. Managed customers do not select backend versions. Self-hosted installs retain local control. Platform stable promotion is the release trigger; rollout activation is explicit and defaults off for the bridge release.

## Architecture and extraction plan

Keep new persistence, rollout, transport, routes, gateway policy and client compatibility logic in focused modules under 500 lines. Existing oversized db.ts, main.ts, platform-startup.ts and gateway server.ts receive only imports/types/registration glue; do not extend their existing business logic. The existing update route block is extracted before adding policy behavior. Session routing delegates update authorization to a focused proxy guard before injecting the machine bearer; the routing entrypoint receives only calls and protected marker wiring.

Postgres owns rollout configuration, per-machine desired/observed state, retry schedule, leases and expiring support overrides. Only customer machines participate. Reconciliation is bounded and restart-safe, proves installed version via authenticated runtime info, and gates subsequent cohorts on a soak period. Failed installs quarantine a release until operator intervention. Unreachable machines retry every five minutes; they never count as verified. Recognized older stable pointers cannot silently downgrade installed releases; intentional downgrades use an explicit operator bridge target.

Passive polling policy is extracted into `matrix-passive-update-policy`; the oversized sync agent only invokes it. Machine identity is not enrollment: a persisted desired version suppresses passive installs even while global reconciliation is paused. Unenrolled machines retain channel delivery unless a live support hold exists. Policy failures defer only the current poll. The shared client reader requires bounded streaming; mobile injects Expo fetch rather than using the non-streaming React Native fallback.

Legacy bootstrap uses the existing authenticated /api/system/update contract with an immutable bridge version; a successful HTTP response is only dispatch, not completion. The reconciler verifies the observed version afterward. Unknown/broken updaters remain flagged for operator recovery; never execute arbitrary remote shell or overwrite customer files. A bridge release must be compatible with old client APIs and migrations must be additive/rollback-safe.

Installed client policy is per desktop OS / mobile OS, with latest and minimum versions, enforcement date and an HTTPS allowlisted download URL. Policy updates use optimistic concurrency. Unknown older clients remain allowed during migration. Updated clients check on launch/resume and periodically; keep updater and sign-in/recovery accessible. A missing policy or platform outage must not manufacture an upgrade requirement. Cache only validated policy responses and preserve a known mandatory gate during an outage.

## Auth matrix

| Route | Auth | Purpose |
| --- | --- | --- |
| GET /client-policy | Public, bounded validated query | Non-sensitive compatibility policy; available before sign-in |
| PUT /backend-management/policy | Platform admin bearer | CAS update of rollout + client policy |
| GET /backend-management/status | Platform admin bearer | Bounded deployment inventory |
| PUT /backend-management/machines/:id/override | Platform admin bearer | Audited, expiring support hold/version-picker flag |
| DELETE /backend-management/machines/:id/override | Platform admin bearer | Audited early revocation of support hold |
| POST /backend-management/machines/:id/retry | Platform admin bearer | Explicitly retry quarantined machine |
| GET /backend-management/machines/:id/policy | Per-machine platform verification token | Gateway reads support override; sync agent checks passive-update permission |
| POST /api/system/update and /upgrade | Existing gateway auth plus managed policy | Operators deploy immutable targets; user version changes require active support override |

Mutations have body limits and strict Zod schemas; errors are generic. Server probes use persisted public IPs only, reject private/invalid addresses and redirects, and have bounded body reads/timeouts. The worker stops/drains before shared DB/dispatcher shutdown. No client version header is treated as authentication.

Customer HTTP proxies replace a customer JWT with a per-machine bearer. Therefore
that bearer alone cannot authorize customer version selection: the platform guards
update/repair/internal aliases against the resolved machine's override before
proxying, including for old hosts. It strips any incoming customer-proxy marker and
injects its own; new gateways require the support override on that path as well.
Integration tests exercise default-session and explicit-VM routing, not just the
policy helper. Direct operator traffic still uses the existing machine bearer.

## Delivery and activation

1. Write failing contract, Postgres rollout and route tests; implement policy + worker + old updater transport.
2. Extract gateway update routes, enforce managed policy, hide public version pickers, disable autonomous channel installs on managed bridge hosts so cohorts cannot be bypassed.
3. Add desktop and mobile compatibility checks and upgrade UI, preserving existing desktop update feeds and mobile runtimeVersion constraints.
4. Ship automated operator tooling (dry-run inventory first), tests and public-safe runbook. Add tests for old endpoint behavior, offline/retry, restart/lease, pause, expiry and user-data preservation.
5. Open implementation PR and separate FinnaAI/matrix-os-site documentation PR. Follow repository review gates; do not merge or activate fleet updates without an explicitly reviewed target.
6. Activate one reviewed bridge canary, verify runtime and client flows, then enable automatic cohorts. Inventory unknown/failed hosts. Publish desktop bridge installers through existing feeds. Mobile versions before 0.2.1 require a store install; OTA cannot retrofit missing native update support. Do not raise minimums until artifact availability and bridge adoption are verified.

## Boundaries

Building automation does not silently deploy/restart ~100 customer machines. Production activation, mobile store publishing and desktop signing require existing release credentials/approvals. Existing machine subscription channels are not trusted as desired state; the platform's stable target wins after bootstrap. Owner data and PostgreSQL are never restored as part of binary rollback. Preserve backward compatibility until fleet and client observations justify retiring it.

## Local validation and outstanding release gates

- Tested the existing update contract, real platform session/explicit-VM proxy
  wiring, support authorization, outage handling, and a simulated 100-machine
  bridge rollout. Verified canaries are rechecked before subsequent cohorts.
- Desktop production build and platform/gateway/desktop typechecks pass. Mobile
  gate and gateway-client tests pass; mobile typechecking has the same 31 native
  component typing errors on the base checkout and this worktree.
- All 180 focused Vitest tests pass. Review-fix coverage for the client policy
  reader and backend repository passes the configured thresholds (100%
  statements/functions/lines, 97.53% branches). The 74 mobile tests and 52 legacy compatibility tests pass.
  Full repository validation remains a review gate; the full unit run was
  interrupted after host-tool incompatibilities and subprocess failures on this Mac.
- Bun is unavailable locally; validation used the equivalent pnpm executables.
  Pattern checks report zero violations, with existing file-level warnings.
- No real VPS, signed installer, store submission, or native-device smoke test
  has been run. Keep fleet activation and minimum-version increases disabled.
- Implementation is published as draft PR #1379. The separate
  public-docs PR requires access to `FinnaAI/matrix-os-site`; its proposed
  content is preserved in `public-documentation.md`.
