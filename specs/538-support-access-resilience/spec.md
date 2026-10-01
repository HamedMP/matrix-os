# Support access resilience for customer VPSes

## Problem and promise

Support SSH can fail when an authorized key, sshd setting, account, or guest
runtime changes. A root-owned key cannot be protected from the current `matrix`
account: cloud-init grants it passwordless sudo and Docker group membership.
Docker's root-run daemon accepts requests from members of that group, so any
process running as `matrix` could obtain host-root privileges even when the
human customer never invokes Docker. See
[Docker's post-install guidance](https://docs.docker.com/engine/install/linux-postinstall/).

The product promise is **recoverable support access**, not an undeletable guest
account. A person with host root can change or remove every guest-local key.
Provider rescue, protected by separate platform credentials, remains the
independent recovery path. A provider outage, deleted server, lost disk, or
compromised provider account is outside this guarantee.

## Goals

1. Normal support login uses a dedicated operator account with root-owned SSH
   authorization, separate from customer data and the owner runtime account.
2. Supported owner shells, agents, apps, and services cannot modify operator
   login, sshd/sudo policy, or root-owned helper code.
3. Operators can restore guest access through provider rescue when guest SSH
   fails, preserving owner files and PostgreSQL data.
4. Installs, upgrades, rollbacks, restore, backups, developer tools, Terminal,
   and the app runtime still work after owner privileges are narrowed.
5. Monitoring proves actual operator login and separately checks provider
   recovery readiness. Provisioned-key records and HTTP health are insufficient.

This specification grants no live customer-VPS change and no routine access
to customer content. If full customer host-root is offered, show the weaker
guest-access guarantee explicitly in product and support policy.

## Current state and dependency inventory

- `distro/customer-vps/cloud-init.yaml` adds `matrix` to `docker` and writes
  `matrix ALL=(ALL) NOPASSWD:ALL` in `/etc/sudoers.d/matrix`.
- `scripts/install-server.sh` also adds `matrix` to `docker`.
- `matrix-restore` uses Docker to run PostgreSQL. Keep Docker as a root-owned
  service until a separate database-runtime migration; removing group
  membership does not require removing Docker.
- `matrix-sync-agent` runs as `matrix` and uses sudo for release installation,
  service control, rollback, and host configuration. Other tool installers
  also use sudo. Every such call needs an audited replacement before removal.
- Provider SSH keys are supplied when a server is created. Adding a key to the
  provider account later does not alter existing guests; see
  [Hetzner's key recovery documentation](https://docs.hetzner.com/cloud/servers/how-to-rescue/change-ssh-key/).

The implementation's first deliverable is a machine-readable inventory of
every legitimate sudo, Docker-socket, systemctl, package-install, root-run
executable, and host-file-write path reachable from `matrix`, its services,
agents, Terminal, and apps. Record caller, input, privilege, intended action,
and replacement. Treat owner-writable root-run scripts/configuration as an
escalation path.

## Trust boundaries

| Resource | Controller | Requirement |
| --- | --- | --- |
| Owner home, projects, apps, personal database | Customer | Owner can inspect, export, and delete. |
| Operator account, authorized keys, sshd/sudo configuration, host helpers | Platform host administrator | Root-owned; no owner-writable ancestors or inputs. |
| Operator private credential | Operator identity system | Never copied to VPS, customer home, image, or repo. |
| Provider rescue credential | Platform infrastructure administration | Separate from guest; incident-authorized and audited. |

Routine support probes read only bounded host and service metadata. Access to
customer content needs an incident reason and applicable support authorization.

## Guest operator path

1. Provision a dedicated non-`matrix` account with locked password and key-only
   SSH login. Use a root-owned authorized-keys source outside owner-writable
   directories. Validate ownership, modes, regular-file type, and symlink-safe
   path before reloading sshd.
2. Use individually attributable credentials and record public fingerprints,
   never private keys. Support rotation and revocation. A first release may
   use per-operator public keys; short-lived SSH certificates are an option if
   their issuer, availability, and revocation model pass review.
3. Grant the operator only the host privilege needed for diagnosis; full-root
   elevation requires an explicit audited incident action. Restrict source
   network where feasible, without making it the sole recovery route.
4. Rotate by adding and validating a new key with a **new SSH session that
   offers only the new credential**, or by verifying the server-recorded
   authenticated fingerprint matches the new key, before revoking the old one.
   A successful connection that may have used the old key is not validation.
   On failure, retain the old working key and alert.
5. Protect sshd/sudo files, keys, service units, helper binaries, release
   configuration, and ancestor directories. Root-run code must reject
   owner-controlled executable paths, symlinks, arbitrary arguments, shell
   interpolation, and environment overrides.

## Owner privilege separation

1. Move legitimate release, restore, and installer operations into root-owned
   services or narrow helpers. A `matrix` request must identify a typed,
   allowlisted action with bounded validated arguments. The root side verifies
   caller identity and release provenance; it never accepts a generic command,
   Docker API request, systemctl unit name, or file-copy destination.
2. Only root-owned restore units may reach the rootful Docker socket. Remove
   `matrix` from `docker` after dependent paths are migrated. Restart sessions
   and services so inherited supplementary groups disappear; a group-file
   change alone does not revoke running processes.
3. Remove `matrix ALL=(ALL) NOPASSWD:ALL` only after all required workflows have
   tested replacements. Validate sudoers with `visudo` and exercise allowed and
   forbidden actions from a fresh owner session. Avoid sudo allowlists whose
   arguments, scripts, or writable files reintroduce root access.
4. If arbitrary root or rootful Docker remains available to customers, treat
   that as an explicit advanced host-control mode. Guest keys cannot be
   protected from that user; provider rescue remains the recovery path.

### Root service wiring and staging limits

- Cloud-init installs root-owned helper binaries and systemd units before
  enabling owner services. The root-owned PostgreSQL startup unit runs before
  the owner-owned restore unit; the gateway and shell start only after restore
  readiness. Upgrades install a candidate helper and unit atomically, validate
  ownership and mode, then reload systemd. A failed validation keeps the
  previous helper and unit active.
- The gateway and `matrix-update` write a bounded, schema-validated update
  request to the owner-visible request location. The root-owned updater reads
  that request through a fixed entry point, revalidates the action and version
  against platform release metadata, and fetches the bundle itself into a
  root-owned staging directory. It never executes the owner-writable request,
  trusts a supplied URL or checksum, or reads executable code from an
  owner-writable ancestor. A local systemd trigger connects the request to the
  updater even when the gateway is unavailable; startup reconciliation picks
  up a pending request after reboot.
- Root staging has a per-release byte ceiling, a maximum number of retained
  candidates, and a finite download and extraction timeout. Archive entry
  count, expanded bytes, path traversal, links, and device entries are checked
  before installation. Failed and expired candidates are removed by a
  recurring symlink-safe sweep using `lstat`; successful candidates are removed
  after the transaction is committed. Rollback artifacts have a documented
  retention window and are never deleted while referenced by an active
  transaction. The sweep timer is stopped on service shutdown.
- A root-owned restore unit starts the fixed PostgreSQL container specification
  and then the owner-owned restore unit loads the database. The owner cannot
  choose a Docker image, mount, socket operation, unit name, or host command.
  Integration tests must boot a disposable VPS from cloud-init, submit a typed
  owner request, observe the root service processing it, and verify startup,
  interrupted-update recovery, restore, and rollback through the real systemd
  ordering. Denied arbitrary requests and staging exhaustion are part of that
  end-to-end test.

## Independent recovery and monitoring

1. Keep a private provider-rescue runbook with separate provider credentials.
   Rescue may reboot the server. Require exact machine identity, incident
   reason, authorized operator, impact notice, and audit before activation.
2. Verify disk identity and backup state before modifying guest SSH. Preserve
   owner home, PostgreSQL data, and installed release. Keep a rollback record.
   After reboot, verify operator SSH plus gateway, shell, and database paths.
3. Periodically test guest operator login with a bounded non-content command.
   Separately preflight provider rescue credentials and machine mapping without
   activating rescue on customer machines. This preflight is not proof that
   rescue boot or key injection works: run a recurring end-to-end drill on a
   disposable VPS using the production recovery procedure, including rescue
   boot, key injection, repair, reboot, and guest-login verification. Alert on
   failure and classify
   key rejection, sshd/network failure, guest runtime failure, and provider
   unavailability.

## Authentication and audit matrix

| Action | Authentication | Authorization | Audit |
| --- | --- | --- | --- |
| Operator SSH | Individual SSH credential | Active support role and host scope | Actor, machine, fingerprint, time, result |
| Root recovery operation | Operator login plus elevation | Incident-scoped policy | Command class, reason, result; secrets redacted |
| Install/rotate/revoke key | Platform or root-owned host migration | Exact machine and operator role | Old/new fingerprints, validation, result |
| Provider rescue | Separate provider credential | Exact machine and approved incident | Actor, target, reboot window, result |
| Owner privileged request | Authenticated local `matrix` caller | Typed allowlisted action | Action, target, result |

No new public HTTP route is required here. Any later control-plane route
requires its own auth matrix, input schema, resource bound, timeout,
idempotency rule, and end-to-end wiring test.

## Rollout and acceptance

1. Publish an audit-only dependency report. Never collect private keys or
   customer content.
2. On a disposable VPS, provision and rotate operator credentials; migrate
   privileged actions; remove owner sudo/Docker access; test fresh install,
   upgrade, rollback, restore, database restart, backup, tool install, and
   Terminal/agent behavior. Test actual user and systemd boundaries, not only
   policy-parser unit tests.
3. Break guest SSH deliberately on that disposable VPS and recover through
   provider rescue. Confirm owner home and database checksums survive.
4. Roll out each existing machine in two gates: first establish and freshly
   verify operator login and provider fallback; then narrow owner privileges
   and restart inherited sessions. Stop if either gate fails. Never remove
   the last working access path.
5. Canary, then stage by cohort. For every machine verify actual SSH login,
   owner privilege-denial tests, runtime health, and installed bundle version.
   A failed workload or lost access halts rollout. Rollback must preserve a
   verified operator path and cannot silently restore broad owner root access.
6. Red/green tests cover denied arbitrary sudo, Docker socket, key/config
   mutation, root-run helper replacement and writable inputs; successful
   operator login; revoked/failed key rotation; application workflows; rescue
   recovery; and alerts without credential or owner-data leakage.

## Deliverables and open decisions

- Privilege dependency inventory and threat review.
- TDD implementation PRs for operator provisioning, narrow privileged
  operations, key rotation/probes, and existing-fleet migration.
- Disposable-VPS evidence, canary/rollback plan, and private rescue runbook.
- Separate public-safe documentation PR in `FinnaAI/matrix-os-site` under
  `content/docs/` describing support access, customer root-mode tradeoff,
  and data boundaries, without host identities or operator commands.
- Decide per-operator keys versus short-lived certificates, and decide whether
  customer host-root remains a supported advanced mode, before implementation.

## Sync-agent extraction plan

Before removing owner sudo or Docker access, move PostgreSQL startup reconciliation
and protected-helper installation, transaction backup, and rollback out of
`matrix-sync-agent` into a root-owned `/usr/local/libexec/matrix-update-helpers`
module. The sync agent should submit a validated immutable version request and
sequence services; the protected updater owns privileged filesystem mutations.

The module accepts only fixed helper names and validated release roots. Keep
installation idempotent, refuse symlinks, and preserve transaction compatibility
when older journals omit a helper field. Separate PostgreSQL reconciliation from
generic helper installation so each stays below 500 lines with one responsibility.
Move the existing executed install/reconcile/rollback tests to that boundary, then
prove upgrade from an older bundle, boot with a running database, failed-update
rollback, and a fresh support SSH login on a disposable VPS. Keep the owner’s
privileges until those gates pass.
