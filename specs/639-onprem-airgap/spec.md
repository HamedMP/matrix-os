# Secure on-premises and air-gapped Matrix OS

Date: 2026-10-31. Status: planning draft; no implementation or licensing change.
Baseline: origin/main 231eff01cf7f67a0c135653848093c30fda3b90d.
Tracking: [ENG-423](https://linear.app/matrix-os/issue/ENG-423/plan-secure-on-prem-and-air-gapped-matrix-os-with-an-optional-ee-layer), assigned to Hamed. Related installer: MAT-146.

## Goal and interpretation

Run Matrix on customer-controlled infrastructure, including a network without internet connectivity, while continuing hosted Matrix development in the same repository. Reuse the same owner runtime, data model, clients and security controls. An optional enterprise layer may add administration and commercial capabilities after its legal boundary is approved.

“In tandem” means shared mainline development and parallel qualification, not divergent runtime implementations. “Open source” and “commercial source available” have different meanings; see licensing.md. This plan does not adopt new license terms.

## Deployment profiles

| Profile | Identity/control plane | Inference | Network |
| --- | --- | --- | --- |
| Hosted | Existing Matrix managed services | Existing owner/funded sources | Existing approved external services |
| Standalone connected | Customer-owned single-owner runtime | Approved local or external source | Explicit outbound capabilities |
| Enterprise connected | Internal identity/admin, owner runtimes | Approved internal or external source | Administrator policy |
| Air-gap | Internal identity/admin and local lifecycle services | Installed internal models only | Approved internal destinations; no internet dependency or attempted background external calls |

Profile describes deployment. Entitlement describes optional enterprise features. Neither grants access to another owner's data. A standalone air-gap core must remain possible without EE code.

## User stories

### US1 — Use core Matrix with internal AI (P1)

An owner selects an installed model and uses Chat, tool actions, files/apps, App AI, Bots, scheduled reasoning and self-healing without cloud AI credentials. All required paths use approved local execution rather than fallback to Claude/funded inference. Adapter capabilities are explicit; unsupported operations fail before side effects.

Independent test: real local inference through the produced runtime, including confined write-capable app creation, tool results, cancellation, restart/resume, background work and App AI persistence. A text answer or read-only demo is insufficient.

### US2 — Install and operate disconnected (P1)

An operator installs a signed release and all declared dependencies from approved media/internal repositories on a fresh supported Linux machine. Reboot, upgrade, rollback, application creation and data restoration work without outside connectivity.

Independent test: empty host/client caches, internet blocked before install, real Postgres/model, outbound and DNS audit from installation through recovery. Offline source rebuild is a separate qualification from offline installation.

### US3 — Administer an organization internally (P1)

An administrator connects private identity, provisions members/runtimes, controls models/integrations and audits changes without Clerk, Stripe, Hetzner or Matrix routing. Owner/org separation and revocation survive WebSockets, subprocesses and reconnects. Community single-owner authentication remains supported.

Independent test: two users and two organizations against internal identity and real storage; cross-owner denial, revocation, key rotation, identity outage and collaboration recovery.

### US4 — Develop core and optional enterprise features together (P1)

A contributor builds/tests community Matrix with EE sources absent. An authorized enterprise build composes the same core through explicit interfaces. Hosted behavior remains qualified at the same source revision. Licensing neither supplies authentication nor disables security.

Independent test: hosted, community-with-EE-absent and enterprise builds, import/artifact/license checks and real startup. Legal adoption of restricted EE terms is a separate prerequisite.

### US5 — Connect every supported client internally (P2)

Users connect Web Canvas, Web Desktop, Electron Desktop, Web Mobile and Native Mobile to configured internal origins and trust chains. Fresh login, reconnect, uploads/downloads, tools and collaboration work without public identity or push infrastructure. Native background behavior and software distribution are qualified separately.

Independent test: actual named surfaces/builds and native/device evidence. A web capture cannot qualify Electron or native mobile. Release claims name only qualified surfaces until all required gates pass; N/A requires architectural rationale and reviewer approval.

### US6 — Prove and maintain security offline (P1)

Operators verify provenance, restrict agent/tool/browser/process egress, rotate secrets/signing keys, import security updates and restore isolated deployments. Source review, adversarial tests and drills produce evidence; network isolation alone is not assurance.

Independent test: authorized non-production threat scenarios in security-plan.md and quickstart.md, including malicious imported apps, model-mediated exfiltration attempts, failed artifact verification and backup restoration.

## Requirements

- FR01: Preserve owner-controlled Postgres/Kysely, inspectable identity/config/export files and existing protected-home rules; no alternative database/ORM or second OS runtime.
- FR02: Administrator-approved inference endpoints use a trusted policy separate from user-provided web URLs. No global private-IP/SSRF bypass; execution-time redirect/DNS/credential-origin controls remain enforced.
- FR03: Every required AI path preserves principal/source/model/session binding, tools, approvals, cancellation and bounded resource use. No external failure fallback in air-gap mode.
- FR04: Server capabilities declare unavailable internet services before execution. Public Gmail/Slack/WhatsApp/search require internal equivalents, imported data or explicit exclusion in strict air-gap deployments.
- FR05: Egress policy covers gateway, agents, tools, app builds, browser, MCP, installers/updater, telemetry and client devices. A fetch wrapper or server-only firewall is insufficient.
- FR06: Offline media includes declared runtime/transitive/OS dependencies, models/tokenizers/templates, provenance, source/notices and authenticated manifests. No lazy downloads on boot or first use.
- FR07: Internal auth, OIDC/JWKS, certificate trust, device approval, routing/discovery and collaboration cannot depend on public services in the air-gap profile.
- FR08: Local releases, backups, restore, observability and optional entitlement checks function without online activation, billing or callbacks.
- FR09: License expiry never destroys owner data or blocks core login/export/backup/restore. Offline time/revocation limitations and degraded management behavior are explicit.
- FR10: Core does not import EE implementation; EE composes public core interfaces. Community source/build/run with EE physically absent is a required lane.
- FR11: New endpoints specify auth, bounded schemas/body limits, safe errors, ownership and timeout behavior. Registries/processes/temp files have caps, cleanup and shutdown owners.
- FR12: Required qualification lanes execute assertions and fail on missing prerequisites, zero collection or skips. Preserve red/green evidence at the real failing boundary.
- FR13: Signed updates verify before extraction/migration, preserve owner data, recover from interruption and define anti-rollback plus schema-compatible downgrade policy.
- FR14: Imported apps, packages, models and backups are untrusted inputs. Validate manifest/path/archive safety and apply the same application/tool permissions as connected Matrix.

## Delivery scope and gates

First vertical slice: proposed Linux x86-64 host-native services, local Postgres, one real internal model/harness, web desktop/canvas and single-owner auth. This is a demonstrator milestone, not enterprise or five-surface readiness. Database container usage is an implementation detail to decide; Docker Compose is not the customer runtime release architecture.

Later gates add disconnected lifecycle, internal organizations/control plane, optional EE composition and remaining surfaces. Exact supported distribution/version, model, hardware, concurrency and performance are measured before a release commitment. No frontier-model parity or previous preliminary timeline is promised.

All applicable quickstart.md journeys must pass using produced artifacts and actual clients. Missing runtime/device/model/identity access blocks the affected readiness claim. Recommend product, runtime/platform, security and client-owner review; obtain rights/legal review before adopting enterprise terms. Public documentation requires a separate FinnaAI/matrix-os-site content/docs PR. Evidence is attached outside the repo to the PR and, when authorized, Slack #tech.

Design: plan.md and contracts/. Evidence: research.md. Execution: tasks.md. Licensing: licensing.md. Security: security-plan.md. Repeated review outcomes: review.md.
