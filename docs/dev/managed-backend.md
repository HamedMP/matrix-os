# Managed backend releases and installed clients

Platform, gateway/kernel and the hosted web shell form the managed backend.
Installed desktop and mobile apps have independent compatibility policies. Backend
versions are an operational concern, not a customer setting. Self-hosted gateways
without `MATRIX_MACHINE_ID` retain manual version selection.

## Sources of truth

- `host_bundle_channels.stable` identifies the approved stable backend artifact.
- `backend_management_policy` holds the CAS revision, enabled flag, bridge target,
  canary IDs, batch size, soak period, and per-client latest/minimum policy.
- `backend_management_machines` records desired and observed versions, dispatch
  intent, next check, failure state and expiring support holds.
- `/opt/matrix/release.json` remains installed-artifact provenance. Provisioning
  `image_version` and persistent channel subscription are not proof of installation.
- `backend_management_audit` retains policy changes and dispatch intents for 90 days.

No migration replaces `$MATRIX_HOME`, customer databases, files, preferences or
identity. Existing host-bundle installation and binary rollback remain the only
normal deployment mechanism. Schema changes must be additive and compatible with
old clients and the rollback binary; binary rollback does not restore a database.

## One-time bridge rollout

Do not enable the fleet before deploying the platform migration and publishing a
reviewed host bundle containing the new managed updater. Defaults are disabled.
Machine identity alone does not enroll a VPS. Until the rollout worker persists
a desired version for that machine, the new sync agent continues its channel's
automatic/security updates. It checks the authenticated per-machine policy before
each poll; a live support hold also suppresses passive installs. A policy outage,
invalid response, or older platform without this endpoint defers that poll and
retries later, so deploy the platform first. Once enrolled, a global pause does
not re-enable passive installs that could bypass canaries or support holds.
Use a normal/manual bridge release: older hosts still obey public `security`/`auto`
channel manifests and cannot be constrained by the new rollout worker until they
have the bridge. Do not promote an auto/security bridge onto a channel used by old
hosts while attempting a staged migration.

1. Deploy the platform and confirm its existing background reconciliation worker
   is running. Cloud Run enables background workers only on the promoted revision
   with CPU throttling disabled. Preview revisions must leave workers disabled.
2. Publish a reviewed immutable bridge version through the host-bundle workflow.
   Do not use its legacy fleet-wide `deploy_after_publish` switch for this rollout.
3. Run `node scripts/release/manage-backend.mjs status` with the existing
   `PLATFORM_PUBLIC_URL` and `PLATFORM_SECRET` supplied by your secret manager.
   This is read-only; console output contains aggregate counts, not customer data.
4. Use the **Managed backend operations** workflow's `enable` action with the
   reviewed bridge version and a designated customer-class test machine ID.
   Alternatively run the CLI `enable --bridge <version> --canary <machine-id>`.
5. The worker installs one canary, independently observes its installed version,
   and requires another healthy observation after the soak period (default five
   minutes). It then sends bounded cohorts (default five machines). A successful
   update HTTP response only means dispatch, never completion.
   Bridge hosts also report bounded systemd checks for shell and sync-agent;
   both must be active alongside the responding gateway. These checks are not a
   substitute for the canary's functional smoke test.
   Previously verified canaries are checked again before new cohorts; a support
   hold or degraded health on a designated canary prevents further fan-out.
6. Check the canary with old and new clients: sign-in, Canvas, terminal reconnect,
   active agent recovery, files, chat and user preferences. First bridge installs
   on legacy hosts can interrupt active work; the old binary cannot acquire the
   new busy guard remotely before its first update. New gateways defer while the
   kernel dispatcher is active or queued. This is not a guarantee of zero downtime
   or of draining every external provider session.
7. Use `verify` for aggregate health; `/backend-management/status` provides
   authenticated paginated detail. Unreachable hosts retry every five minutes.
   Installation verification failures or uncertain requests that exceed thirty
   minutes are quarantined and stop new cohorts. Investigate before using
   `retry --machine <id>`; do not blindly restart a failed installation repeatedly.
8. Once inventory proves the bridge is installed, use `follow-stable`. This clears
   the bridge target; future stable promotions are picked up automatically.
9. Enable repository variable `MANAGED_BACKEND_OPERATIONS_ENABLED=true`. The
   scheduled workflow checks fleet health twice an hour and fails when an enabled
   fleet contains offline/quarantined machines. Stable desktop publication also
   updates the latest macOS client version automatically, without raising minimums.

The existing exact-version `/api/system/update` endpoint is the legacy bootstrap
contract. Older releases with a missing/broken endpoint are reported as unconfirmed
then quarantined; no SSH scripts or arbitrary shell are silently executed. Such
machines need a reviewed break-glass repair through the private support system.
No implementation can retrofit an updater into an unreachable process. Inventory
and the first canary establish which part of the real fleet needs that exception.

## Pause, support holds, and recovery

`pause` stops new dispatches, but cannot undo an update already accepted by a VPS.
The lease and dispatch intent survive platform restarts; another platform replica
observes the existing operation instead of issuing a concurrent restart.

An operator can PUT `/backend-management/machines/:id/override` with `until`,
`reason`, and `allowVersionSelection`. Holds expire within seven days. An active
hold prevents the reconciler from moving that machine, and optionally exposes the
version picker to the customer. Gateways cache this permission for at most thirty
seconds and never beyond expiry. UI hiding is backed by gateway authorization and
a platform proxy guard that also protects old gateways. The proxy replaces customer
credentials with a machine bearer, so it strips and reinjects the customer-proxy
marker and checks the override before forwarding update requests.
Do not use a hold to cancel an installation already in progress.
DELETE the same override endpoint to clear it early; gateway caches converge
within thirty seconds, while the platform proxy enforces revocation immediately.

Recognized older stable pointers do not trigger automatic downgrades. A newer
installed release requiring a downgrade is quarantined for review. Use a reviewed
explicit bridge target for an intentional rollback; retain additive database
compatibility because binary rollback cannot roll back owner data.

The per-machine operator credential remains the existing `UPGRADE_TOKEN`, not a
client header or feature flag. Customer JWTs cannot select versions without a
support override. A machine owner with host/root access can change their own OS;
this policy is not an attempt to remove ownership or export rights.

## Client policy and migration

GET `/client-policy?target=<target>` is public and uncached, including before
sign-in. Targets are `desktop-macos`, `desktop-windows`, `desktop-linux`,
`mobile-ios`, and `mobile-android`. Each configured target has:

- `latestVersion`: recommend updating below this version.
- `minSupportedVersion`: require an update below this version after `enforceAfter`.
- `enforceAfter`: ISO timestamp that permits a bridge adoption/grace period.
- `downloadUrl`: HTTPS Matrix, official repository release, or app-store URL.

The CLI `set-clients --file <policy.json> --artifacts-verified` updates these rules
with optimistic concurrency. Verify signed installers/store availability for
all affected OS versions and architectures **before** raising a minimum. Keep
minimums unchanged for ordinary feature releases. Mac publication updates latest
automatically only after its existing multi-architecture release job succeeds.
Windows/Android/iOS policies are set after their respective release is available;
this change does not invent an unreleased installer or bypass app-store review.

New clients check at startup/resume and each minute, retain validated policy on
transient failures, and expose download/install actions in the upgrade gate.
Mobile uses Expo's streaming fetch; policy bodies are capped at 8 KiB while
reading. A missing stream aborts the request and preserves cached requirements
instead of buffering an unbounded native response.
API requests from identified unsupported clients receive a generic HTTP 426.
Policy, auth and recovery remain reachable. Client version headers are hints for
compatibility, not authentication. Legacy clients without version metadata remain
allowed during bridge adoption; do not remove their APIs merely because new
clients now have a minimum-version screen.

Existing desktop updaters receive a bridge through their current release feed.
Users must still allow installation/restart; an old binary cannot remotely gain a
new UI without installing it. Preserve old feed URLs and device-auth contracts.

Mobile OTA exists only from v0.2.1. Earlier builds require an app-store install.
OTA patches must be built from the matching native runtime; current SDK 57 JS
cannot be published to an older native runtime by relabeling `runtimeVersion`.
Use a runtime-compatible bridge from that version's source, or a store update.
See [mobile shell](mobile-shell.md#over-the-air-updates-eas-update).

## Validation and release discipline

Run the managed-backend, legacy transport, client policy, gateway authorization,
web/desktop settings and native mobile gate tests. Test a disposable customer-class
VPS before fleet activation. Keep the previous immutable artifact for recovery.
Do not remove old API behavior until client adoption and fleet observations prove
it is safe. The companion public documentation belongs in the private site
repository; the proposed text is in the feature spec until that PR is published.
