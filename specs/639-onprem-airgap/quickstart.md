# Qualification runbook: on-premises and air-gapped Matrix OS

**Status:** acceptance procedure for planned work, not installation instructions for an available air-gap release. The scripts below are proposed by [tasks.md](tasks.md). Do not run absent scripts, substitute mocks or label this planning baseline qualified.

**Tracking:** [ENG-423](https://linear.app/matrix-os/issue/ENG-423). Read [spec.md](spec.md), [plan.md](plan.md), [contracts/](contracts/) and [security-plan.md](security-plan.md) before qualification.

**Edition direction:** the requester selected AGPL core plus publicly developed commercial EE, following the PostHog-style layout. No new terms are adopted by this plan. Qualifying/distributing restricted EE requires recorded legal and rightsholder clearance for the actual code combination; pending clearance does not block shared AGPL-core development or qualification.

## Qualification target and claim

Run in disposable customer-equivalent infrastructure with synthetic owners and data. The target is the exact exported installer/runtime/client artifact plus declared model/dependency set, not a developer checkout or warm online machine. No primary customer machine, production release, external message or paid fleet rollout is authorized by this runbook.

Use Codex's in-app browser for browser interaction. Browser-related scripts or qualification tasks do not authorize launching external Chrome/Chromium/Playwright browsers; an interaction that cannot be completed in-app needs explicit current-task authorization for that fallback. Native/client device evidence still requires its declared runtime.

Distinguish these claims:

| Claim | Necessary proof |
|---|---|
| Local read-only spike | Actual Matrix catalog/admission → exact local model → streaming and permitted read tool. It does not establish app creation or full Matrix parity. |
| Web-first demonstrator | Local authenticated web runtime, sandboxed file/app writes, background work, App AI/Bots and explicit unavailable capabilities. It is an intermediate supported scope only if separately approved. |
| Disconnected installation | Fresh host and clients, empty caches, external egress blocked before install, complete local artifacts, first-use/periodic work and lifecycle tests. |
| Full air-gap product | Every included profile/capability plus internal org authority and all five named surfaces pass their real acceptance lanes; mandatory security and operational evidence is complete. |
| Offline source rebuild | Rebuilds from source entirely within the gap using a complete pinned compiler/runtime/package/model supply chain. This is a separate deliverable; disconnected installation does not imply it. |

## Inputs required before execution

Record these values in a private run record stored outside the repository. Missing mandatory input fails the selected lane.

| Input | Required identity/evidence |
|---|---|
| Source/artifacts | Git commit, release version, edition/profile, installer/verifier/updater versions, file hashes, verified manifest signature, trust-root version and build provenance. |
| Host platform | Exact Linux distribution/kernel/CPU architecture, CPU/RAM/storage and GPU/driver/runtime; pinned Postgres distribution/image digest and schema version. |
| Inference | Server/runtime version, model/weights hash, quantization/tokenizer, model rights, context/output/concurrency settings and workload/capacity thresholds measured in T003/T004. |
| Internal services | Internal DNS/time/CA/IdP/storage/relay/registry endpoints, approved origin/port list, issuer/audience identifiers, internal clock source and certificate validity. Keep credentials out of evidence exports. |
| Identity/policy | Installation ID, two separate users and organizations where selected, immutable internal identity bindings, installation operator and narrower org-admin policies. |
| Clients | Exact browser/OS/viewport, packaged Electron version/signature, native iOS/Android installed build/device, client artifact hashes and CA trust setup. Expo Go is not a native qualification runtime. |
| Recovery | Approved backup destination/key custody, backup manifest/schema, second clean host, supported migration/rollback path and interrupted-phase recovery protocol. |
| Evidence | Private external artifact directory, sanitized evidence-sharing links, network captures/denial logs, service logs, screenshots/recordings, executed test counts and independent security review references. |

Do not invent latency/concurrency/RPO/RTO targets here. T004 sets accepted limits from measured representative work. Report actual distributions, cold versus warm behavior, context size and concurrency. A model that returns fluent text but fails required tools/workloads is not a passing reference profile.

## Network and trust setup

1. Prepare the release outside the gap. Export verified immutable artifacts, complete dependency closure, model/tokenizer files, database images where selected, approved app templates/packages, notices/SBOM/source obligations and offline trust metadata.
2. Start clean host(s), storage and client profiles without public caches. Transfer the release by the approved controlled import path. Verify signature, platform compatibility and every required hash before running any payload/lifecycle script.
3. Install customer CA trust through supported OS/client mechanisms. Use internal HTTPS origins. Never disable certificate validation, use auth/test bypasses, or point a production-advertised provider at a fixture to obtain a passing result.
4. Enforce deny-by-default external network access **before** installation. Allow only reviewed internal DNS, time, IdP, inference, storage, package and relay services. Include IPv4/IPv6, proxy/alternate routes, DNS-over-HTTPS and device/browser routing in the policy review.
5. Observe attempted as well as successful external calls on servers, subprocesses, containers/isolated workers, app builders, browser workers and each native client. A firewall blocking a hidden call is useful enforcement, but repeated external attempts still fail strict offline-behavior qualification until removed or explicitly resolved.
6. Verify policy authority: installation operator owns global endpoint/CA/egress ceilings. An org administrator can narrow its own org policy only. Attempts to add trust, widen LAN/egress access or alter another org must be denied and audited.
7. Capture baseline outbound counters and authenticated internal requests. A global JavaScript `fetch` stub cannot observe Python SDKs, native binaries, subprocesses or browser/service-worker traffic and is not final proof.

Do not assume an internal hostname is safe because it resolves privately. Validate the approved service identity, origin, certificate and address/redirect behavior at the relevant transport boundary; deny metadata and unrelated internal resources. Do not relax arbitrary user-supplied URL guards globally.

## Run order and evidence matrix

Each row is a required scenario when its capability/profile is selected. Tests exercise production modules/clients through real services and persistence. Deterministic fixtures remain useful for regression/fault injection, but final passing rows require the actual selected runtime/model/DB/device. Unavailable prerequisites, zero tests or skipped mandatory assertions fail the lane.

| ID / tasks | Actor and trigger | Observable completion | Failure/recovery and authority proof |
|---|---|---|---|
| Q01 / T031–T035 | Operator imports and installs on empty host with denied internet | Verified package installs selected runtime, Postgres, agents/editor and default apps; local TLS/login/gateway work | Corrupt/missing payload, wrong platform/key, malicious archive or unsupported schema rejected before mutation; no apt/image/registry download escapes. |
| Q02 / T017–T021 | Owner cold-starts Settings and selects an internal model | Actual route admission, text stream, permitted read tool and selected model/account/endpoint lineage | Keyless server has explicit readiness without fake cloud credentials; stale catalogs, invalid CA, revoked key, changed DNS/redirect and provider failure cannot select cloud/account fallback. |
| Q03 / T019–T023 | Owner asks the local agent to create/edit a supported app | Real workspace files change, Vite build finishes, app persists/reopens and DB-backed behavior works | Protected home/system files, sibling owners, credentials/socket paths, unapproved commands and LAN destinations are denied. Missing package is bounded/unavailable, without public-registry fallback. |
| Q04 / T024–T025 | Scheduled agent task/healing triggers under local route | Real intended approved effect, persisted state and accurate visible outcome | Distinguish notification cron from agent work; cancellation, failed healing and restart preserve backup/rollback and do not silently replay uncertain writes. |
| Q05 / T026–T028 | App and Bot request internal inference/tools | App AI returns text under its grant; Bot executes only separately approved tools | App cannot inherit owner tools/credentials; isolated workers lack arbitrary LAN access; model/route/owner mismatch, oversized stream and revocation deny safely. |
| Q06 / T029,T042 | User invokes each advertised speech/image/search/MCP/support capability | Included local provider works; deliberately excluded capabilities show accurate unavailable state | No hidden SaaS/telemetry/support call or indefinite retry; no fixture labeled a production provider. Internal corpus search is labeled separately from public web search. |
| Q07 / T038,T043 | Operator rotates certificate/trust root/model-service credentials and changes internal time | Supported overlap/renewal path retains valid service access and accurate audit | Wrong name/issuer, expired/revoked trust, clock skew/rollback and unsupported key version fail safely without widening trust or disabling TLS verification. |
| Q08 / T045–T050 | Two users in distinct orgs authenticate and access resources | Installation+issuer+subject maps to immutable internal IDs; authorized collaboration preserves personal/org ownership | Same subject from foreign issuer, reused email, forged headers, replay, old membership and shared-owner fallback cannot expose data. Revoke during WS/run; subsequent effects denied. |
| Q09 / T047,T053–T054 | Operator migrates existing owner data, rotates internal identity keys, then restores | Data belongs to the same reviewed immutable owner/org mapping after migration/restore | Missing/mismatched mapping stops for explicit recovery; never assign through matching email, raw subject or configured-owner fallback. Mixed-version key rollout cannot resurrect revoked authority. |
| Q10 / T048–T054 | Internal org uses object storage, relay and approved connectors | Selected internal services work using scoped credentials and bounded delegation | Cross-org request/policy changes deny; no Matrix Cloud/Stripe/Hetzner/Pipedream prerequisite; absent remote backup differs from unavailable storage. Hosted canonical EU storage regression remains green. |
| Q11 / T055–T062 | Builder removes EE physically; enterprise operator imports signed entitlement if selected | Community builds/runs/exports data without EE; enterprise uses the same qualified core commit and approved license structure | Reverse import/package dependency fails CI. Forged/wrong-deployment/expired/revoked entitlement and clock rollback follow defined grace/recovery without call-home, data lockout or relaxed authorization. |
| Q12 / T036–T038 | Operator imports exact new release and interrupts each update phase | Version/provenance are exact, schema compatibility holds, services recover, owner files/DB remain intact | Bad signature, unapproved downgrade, stale channel, low disk, corrupt journal and power loss produce deterministic repair or preserved recoverable state; DB rollback limits are enforced. |
| Q13 / T039–T040 | Operator backs up and restores to a second empty host | Owner DB/files/app assets/secrets/permissions and identity mappings recover; actual RPO/RTO measured | Partial/corrupt backup, wrong key/owner, missing secrets and inaccessible storage fail safely; no hosted broker or fresh internet bootstrap required. |
| Q14 / T063–T070 | Cold client authenticates with internal identity and uses Chat/app/terminal | Each selected surface completes actual API/WS/tool/app flow, cancellation, logout and reconnect | No Clerk bootstrap/session required for standalone/internal profile; revoked sessions fail; assets, CA trust, CSP and credential custody validated in real packaged/device runtime. |
| Q15 / T074–T076 | Concurrent users trigger slow/large inference, tool loops, disconnect, gateway/native model process loss and shutdown | Bounded queue/resources and safe errors; subsequent requests recover within measured limits | Gateway restart and native process loss are tested separately; uncertain effects are not replayed; dead subscriptions drain; no hidden egress on retry or fallback. |
| Q16 / T071–T080 | Independent reviewer evaluates exact final artifact/source | Confirmed defects validated/fixed/regressed; scope and residual risks explicit | Static scan success alone is insufficient. Missing Daybreak access remains recorded; required independent review uses Daybreak Blue or a documented security-owner-approved alternative. |

### Process and client coverage ledger

For Q01–Q16, the private evidence record must enumerate reviewed processes rather than say “all network traffic” without coverage:

- Installer, package managers and lifecycle hooks; database image/import/start; systemd bootstrap and deferred developer tools.
- Gateway, kernel/Claude-oriented helpers retained by the profile, Pi/OpenCode/Python harnesses, inference broker/server and Bot/App AI isolated workers.
- App builder, Vite/runtime app, custom MCP servers, browser tools, filesystem/database/object-storage clients and background/backup/update timers.
- Shell server plus clean Web Canvas/Web Desktop/Web Mobile browser sessions, lazy chunks, fonts/assets, service workers, analytics/feature flags/support paths.
- Packaged Electron main/renderer/embeds/update path and native iOS/Android app/network/WebView paths, including login, push/distribution exclusions and credential recovery.

Record observed internal targets and rejected external attempts with credential/customer-content redaction. The ledger is runtime evidence outside the repository; link only sanitized summaries in the spec/PR.

## Five surface matrix

One surface cannot stand in for another. Native Mobile includes separate iOS and Android runs for advertised OS support; Web Mobile uses a real mobile browser/layout, not only a desktop screenshot resized after rendering.

| Surface | Minimum final evidence | Required runtime boundaries |
|---|---|---|
| Web Canvas | Screenshot and recording of cold auth, Chat tool/app creation and recovery | Actual shell/canvas route → gateway → internal identity/model/Postgres; terminal/app bridge if advertised |
| Web Desktop | Screenshot and recording of desktop launch, Chat/app/terminal and reconnect | Actual desktop launcher/windows, permissions, same internal services and asset loads |
| Electron Desktop | Exact signed/package hash plus screenshot/recording | Installed app main-process auth, gateway-scoped CSP, embedded apps, terminal, internal CA and update/distribution path |
| Web Mobile | Device/browser/viewport identity plus screenshot/recording | Actual mobile launcher/browser runtime, keyboard/terminal/app/auth/reconnect |
| Native Mobile | Exact native build/device/OS and screenshot/recording for each supported OS | Fresh Clerk-free internal bootstrap, SecureStore/session lifecycle, real REST/WS/WebView/capture and installed dev/release client |

An excluded surface/capability needs architectural rationale and reviewer-approved scope. It cannot be counted toward a full-product acceptance claim. Store screenshots/recordings outside the repo, attach actual accessible evidence to PRs, and include commit/build, scenario and any fixture/bypass limitation. Mockups and automated test counts alone do not satisfy visual qualification.

## Test and artifact execution contract

After implementation, run the produced tools through the official pnpm/bun workflow in their owning manual worktree. Proposed entrypoints live in `scripts/offline/` and `scripts/qualification/airgap/`; implementation tasks must provide documented argument schemas and bounded cleanup. This document intentionally does not invent a CLI that does not yet exist.

The qualification harness must:

1. Validate selected lane prerequisites up front and fail nonzero on absent model/runtime/DB/device, empty collection, missing evidence or skipped mandatory assertions.
2. Bind each result to source commit, release/client/model hashes, profile, reference hardware and service configuration fingerprints. Do not include secrets.
3. Use actual production routes/processes/artifacts, assert durable effects with independent reads/reopen, and preserve original denied/recovery behavior when injecting faults.
4. Save executed case counts, assertion outcomes, raw logs/captures and screenshot/recording references outside the repository; keep a public-safe index.
5. Clean only synthetic test data, disposable hosts and task-owned temporary files after evidence is retained; no forced deletion of uncertain shared resources.

Required CI selection:

| Lane | Must prove |
|---|---|
| Core/community absent EE | Real build/typecheck and selected behavior with `ee/` physically unavailable, no enterprise secrets or declarations. |
| Existing hosted | Auth/owner routing/funding/provisioning/storage/channel invariants remain intact for the same shared-core revision. |
| Standalone connected | Existing installer/proxy/local auth/terminal/editor and owner-data preservation remain operational. |
| Offline core | Real empty-cache import/install and local inference/write/app/background/backup/update behavior under enforced egress policy. |
| Enterprise offline | Real internal IdP/org/storage/collaboration/entitlement if selected, all required client surfaces and security qualification. |
| Supply chain | Signature/provenance/SBOM/notices, immutable dependency/model closure, trust rotation and rejected tampering/downgrade. |

## Security review and release record

Daybreak access was unavailable during the initial planning check on 2026-10-31; that is an access observation, not a vulnerability result and not an excuse to omit security work. Recheck before the independent review. Never label a normal Codex source review as a Daybreak Blue run. Record actual program/tool, revision/scope, scan ID, artifact/report paths, coverage/deferred areas and verified remediation. Sensitive vulnerability detail stays in private security artifacts; public tasks/docs contain safe remediation references.

A release candidate is ready for human release review only when Q01–Q16 selected cases, the five-surface matrix, mandatory independent security review, capacity results, source/license review, owner-data backup/restore and required CI pass against the exact artifact. Record residual limitations and supported deployment combinations. Claim neither complete vulnerability coverage nor untested model/hardware/native parity.

Before release, link ENG-423, native stack/PRs, implementation/spec/contracts, sanitized test and visual evidence, signed release/provenance/SBOM, legal rights decision, measured reference profile, rollback/schema limits and support/recovery runbooks. Include a separate `FinnaAI/matrix-os-site` PR under `content/docs/`. Posting evidence to Slack `#tech`, merging and production release remain separate authorized actions; preparation of this runbook does not perform them.
