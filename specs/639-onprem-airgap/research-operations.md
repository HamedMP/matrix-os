# Operations research: on-premises and air-gapped Matrix OS

Date: 2026-10-31. Source baseline: `231eff01cf7f67a0c135653848093c30fda3b90d`.

This is a static source review. No disconnected VM, installer, upgrade, restore, package registry, internal certificate authority, or production service was exercised. Line references below identify the reviewed baseline. Proposed files and contracts are design recommendations, not existing implementation.

## Findings that change the delivery plan

1. The standalone install is a useful single-owner starting point, but it is an online bootstrap rather than an offline installation product. A custom host-bundle URL does not remove apt, database-image, first-boot agent, and editor downloads.
2. Existing host bundles carry runtime dependencies and default apps, but building them still requires a Clerk publishable key and upstream downloads. A distinct build profile is required; inserting dummy hosted credentials is not qualification.
3. Internal S3-compatible storage has a real configuration seam. However, the production customer-VPS profile separately enforces the canonical EU R2 endpoint. A generic internal storage setting does not establish a fully independent control plane.
4. The update engine already has staging, transaction, repair and rollback machinery. Extend that shared engine with a verified local artifact source; do not create an EE-only second updater.
5. App creation is a continuing supply-chain dependency after installation: an agent can generate a Vite app whose manifest invokes a package install. Shipping the shell alone is insufficient.
6. Desktop/web assets are partly well-positioned: fonts ship through Fontsource and standalone code-server routing is same-origin. Analytics, source-map upload, support, and feature flags still need an explicit offline profile and a network test.
7. Org collaboration is not a direct consequence of standalone install. Standalone layout deliberately sets no organization, while collaboration needs a configured authority, runtime identity, service token and relay. Enterprise multiuser is a separate milestone.

## Observed source inventory

| Boundary | Verified source behavior | Implication / action |
|---|---|---|
| Installer artifact source | `scripts/install-server.sh:7-14` defaults to Matrix-hosted bundles and install telemetry; `:298-325` accepts HTTPS only and preflights bundle/checksum URLs; `:479-504` downloads both and compares SHA-256. | Introduce a local-media/import path and internal HTTPS repository. Preserve hash checking and add a separately trusted signature root; do not mistake a checksum delivered with its artifact for independent publisher authentication. |
| OS packages | `scripts/install-server.sh:372-386` runs apt update and installs system dependencies. | The supported offline baseline must contain matching package payloads or an internal apt mirror, including transitive native dependencies and certificate packages. Preflight all prerequisites before mutation. |
| Owner configuration | `scripts/install-server.sh:426-476` sets self-host mode, generated local secrets, loopback Postgres and gateway; funded AI and managed speech default off. | Reuse the standalone configuration, with explicit typed deployment capabilities. Do not enable cloud features merely because a stale environment variable is present. |
| Database first boot | `scripts/install-server.sh:530-547` generates a standalone database gate using `postgres:16`; `distro/customer-vps/host-bin/matrix-postgres-start:15-27` has the same image dependency in the managed host path. | Include a digest-pinned database image and offline import, or a separately qualified native Postgres mode. A tag-only database start can require registry access on a fresh host. The Matrix runtime remains VPS-native; this database detail is not permission to replace the runtime with Compose. |
| Runtime bundle build | `scripts/build-host-bundle.sh:8-33` defines Node/Zellij/GitHub CLI/uv upstream sources; `:38-53` installs/rebuilds packages and requires Clerk; `:58-68` consumes build-time telemetry values and builds Next; `:73-84` builds CLI/default apps and downloads runtime files. | Build in a controlled connected staging environment, export all dependencies and provenance, and qualify a separate offline build only if source rebuilding inside the gap is a requirement. Offline runtime installation and offline source build are distinct deliverables. |
| Tool packs | `distro/customer-vps/host-bin/matrix-install-tool-pack:197-237` installs Claude, Codex, OpenCode and Pi packages; `:263-272` downloads code-server; `matrix-install-hermes:22,83` downloads a pinned upstream installer; `matrix-install-linux-tools:92-101` installs packages/Homebrew bootstrap. | Bundle only supported tools plus all transitive runtimes. Optional unsupported tools should fail preflight with a capability result, rather than enter recurring internet retries. Reproduce Python/uv, npm, native binaries and browser payloads where selected. |
| Deferred installs | `distro/customer-vps/systemd/matrix-developer-tools.service:12-13` executes the tool installer from host configuration. | Qualification must cover first launch and later selection of a tool, not only initial boot. Keep deferred installation local and bounded. |
| Release publication | `scripts/publish-release.sh:124-172` constructs checksums/release metadata; `:299-329` uploads object payloads; `:450-455` registers a release with the platform; `scripts/publish-release-r2.mjs:95,283-286` uses the platform and object-store configuration. | Keep current hosted publishing intact. Add export/import of the same immutable release identity and signed manifest for customer repositories/media. Private customer environments need no release-registration call to Matrix Cloud. |
| Update subscription and transaction | `distro/customer-vps/host-bin/matrix-sync-agent:50` selects a configurable manifest base, falling back to Matrix Cloud; `:601-638` records transaction payload/files; `:710-764` restores them; `:913-932` constructs channel/version URLs. `matrix-update:17-27,35-58` writes explicit update/rollback/repair triggers. | Existing engine is a shared-core extension point. Add local artifact resolution before mutation, strict offline polling policy and explicit downgrade authorization while retaining installed artifact provenance and owner data. Reuse transaction recovery. |
| Update UI | `packages/gateway/src/system-update.ts:305-324` composes the configured manifest URL and fetches it; `:335-338` includes owner-managed/no-platform cases. | UI and daemon must share deployment policy. A hidden update button does not stop daemon egress. |
| Database backup | `distro/customer-vps/host-bin/matrix-db-backup.sh:17-46` creates a local pg_dump then pushes snapshot/latest through `matrixctl r2`; `:48-51` retains 24 local dumps. Hourly timer: `systemd/matrix-db-backup.timer:4-5`. | Add explicit local/internal storage destinations, encryption and tested retention policy. Include owner files, secrets, app assets and database consistency; a DB dump is not a whole-computer backup. |
| Hosted restore | `distro/customer-vps/host-bin/matrix-restore.sh:67-104` probes remote metadata/pointer; `:118-149` downloads and restores a DB dump; `:25-64` protects/atomically writes its completion marker. | Extract shared restore verification but keep standalone fresh installation distinct from disaster recovery. Restore must succeed with no hosted broker, and distinguish missing backup from unavailable storage. |
| S3 abstraction | `packages/platform/src/object-storage-config.ts:18-45` accepts S3 endpoint, credentials, separate bundle bucket and path-style options. `platform-startup.ts:764-788` constructs primary/bundle stores. | Reuse this seam and qualify an internal implementation. Maintain separate credentials and buckets for owner sync, release artifacts and public/intranet assets. |
| Hosted storage restriction | `packages/platform/src/platform-startup-env.ts:110-147` requires canonical EU R2 for production customer VPS; `:150-179` requires distinct bundle storage; public sites `:18-34` accepts R2-specific endpoints. | Add deployment-profile-specific validations, retaining the hosted EU invariant. Internal enterprise storage is not safely enabled by weakening the global check. Public sites need a distinct intranet publishing adapter or exclusion. |
| Control-plane modes | `packages/platform/src/runtime-mode.ts:3,46-78` supports cloud_run/compose/local, requires platform Postgres, and treats non-cloud_run as legacy container orchestration enabled. | Do not reuse `local` as an implied supported enterprise mode. Define a deliberate enterprise composition root without accidental legacy Docker orchestration or hosted lifecycle workers. |
| Identity/collaboration | `packages/platform/src/platform-startup.ts:458-478` creates Clerk auth if configured and passes it to collaboration. `packages/gateway/src/collaboration/config.ts:52-100` needs runtime identity/platform/service token; relay defaults to Matrix Cloud at `:12,113-117`. | Introduce customer-controlled identity/authority and explicit internal origins. Preserve fail-closed configuration, owner/org isolation, signed actor provenance, membership revocation and runtime registration. Do not use one shared nginx account as enterprise RBAC. |
| Shell standalone | `shell/src/app/layout.tsx:64-91` omits Clerk, hosted billing tracking and PostHog identification and provides organization `none`. `shell/src/lib/feature-flags.ts:19-26` changes editor routing to same-host `/code/`. | Good reuse, with an explicit single-owner scope. Enterprise org contexts require new adapters and tests. |
| Fonts/assets | `shell/src/app/layout.tsx:3,8-11` and `shell/src/app/fonts.css:1-14` use packaged fonts. | Keep packaging local; inventory all icons, images, workers, maps and lazy chunks under the exact production build. Do not claim every asset is local based on fonts alone. |
| Analytics/support | `packages/observability/src/client.ts:62-71` returns no client without a token. `shell/src/lib/posthog-client.ts:24-29` uses build-time keys; `:93-109` captures events/support when configured. `shell/next.config.ts:63-73` rewrites relay traffic to PostHog; `:124-134` conditionally uploads source maps. | Offline profile must disable initialization and external relay routes even if hosted build variables leak into a build. Provide local diagnostic export/metrics separately. Client browser traffic matters as much as server traffic. |
| Install telemetry | `scripts/install-server.sh:170-173,235-257` supports opt-out but defaults enabled. | Offline installation must default to no outbound reporting at all, including failure paths. An opt-out instruction is insufficient. |
| Feature rollout | `shell/src/components/get-started/ShellGetStartedGate.tsx:18-37` bypasses Clerk and PostHog flags for self-hosted mode. | Retain this explicit pattern. Inventory other feature-flag consumers; core readiness must not depend on a remote flag service or its last cached value. |
| Integrations | `packages/platform/src/platform-startup.ts:533-554` conditionally constructs Pipedream from configured integration settings; gateway `integrations/platform-proxy.ts:78-101` forwards with server-derived identity and bounded fetch. | Cloud integration broker is optional scope. Intranet integrations need a controlled connector/MCP path and internal OAuth callback/issuer; preserve delegation and approval protections. |
| Speech | `packages/gateway/src/speech/gateway-runtime.ts:27-48` constructs a platform client/transcriber when configured. `packages/platform/src/speech/config.ts:108-126` permits a nonproduction fixture or OpenAI provider. Voice STT/TTS also call OpenAI/ElevenLabs (`voice/stt/whisper.ts:54`, `voice/tts/openai.ts:25`, `voice/tts/elevenlabs.ts:31`). | Either provide local STT/TTS adapters and model assets or explicitly exclude voice from the first supported profile. Fixtures do not qualify production offline speech. |
| App generation/build | `packages/gateway/src/app-runtime/manifest-schema.ts:14` defaults install to `pnpm install --frozen-lockfile`; `build-orchestrator.ts:158-178` executes manifest install then build; `scripts/build-default-apps.mjs:96-127` builds packaged apps from manifests. | Provide approved app templates and a complete offline package store/internal registry. Missing packages must produce a bounded actionable result without public-registry fallback. Arbitrary newly requested dependencies cannot be promised offline. |
| Web/search | `packages/kernel/src/tools/web-search.ts:114,143-144,196` calls public search/model providers; `tools/web-fetch.ts:196` has a Firecrawl path. | Strict air-gap scope includes intranet retrieval or imported corpora, not live public web/search. Use capability discovery to avoid promising unavailable tools. |
| TLS/DNS/time | Managed cloud-init config uses local certificate files (`cloud-init.yaml:303-304,326-327`) and generates a 30-day self-signed certificate (`:690-692`). Standalone nginx currently listens HTTP (`scripts/install-server.sh:613-620`). | Enterprise installer must accept internal DNS names, trust roots and server certificates, support rotation and internal time sources, and qualify trust in browsers/native clients. No source-backed claim is made that current installers supply enterprise DNS/NTP/PKI management. |

No current Inngest runtime dependency was found in the targeted platform/env search. A historical migration specification is not evidence that Inngest needs replacing. Repeat the dependency inventory against each release rather than treating an old architecture diagram as authoritative.

## Delivery profiles and scope

### First qualified disconnected profile

Target one pinned supported Linux/CPU baseline, one owner, web shell, owner-local Postgres/files, one qualified local AI server, bundled apps/templates, terminal/editor, local backup and manual offline update. Include internal HTTPS and a customer CA trust procedure. Disable external integrations, public sites, cloud funding/billing/provisioning, telemetry/support calls and internet search. A local model server can be another customer machine; air-gapped does not mean every component must run in one process.

Single-owner acceptance does not establish multiuser security or organization collaboration. State excluded surfaces in the capability inventory and product UI; do not silently leave nonfunctional buttons.

### Enterprise follow-on profile

Add internal IdP and user lifecycle, organization ownership/RBAC, local collaboration authority/relay, internal object storage/backup, administrative inventory and policy, signed offline entitlement if commercially selected, local telemetry/SIEM integration and controlled fleet updates. Desktop/mobile and local speech require separate runtime and distribution qualification. Internal app publication/catalog and connector governance are additional capabilities, not automatic reuse of Matrix Cloud services.

## Proposed code boundaries

Keep the following in shared core so hosted development benefits and community builds remain useful:

- Typed deployment capabilities and explicit service adapters; no entitlement-controlled weakening of security.
- Artifact verification/import, shared updater transaction/recovery, preservation of `$MATRIX_HOME`, backup/export/restore primitives.
- Local AI endpoint support with a narrowly scoped administrator policy, generic identity/authority interfaces, internal storage transport, safe error handling and egress restrictions.
- App/runtime package resolution and an offline template/package contract.
- Local diagnostics, predictable disabled-service states, production assets and test harnesses.

Candidate EE ownership, conditional on the separate licensing decision: enterprise IdP provisioning/SCIM administration, policy and fleet-management UI/services, enterprise audit export/retention management, supported offline distribution composition, and commercial entitlement handling. Composition should be one-way: enterprise wires the shared contracts; shared core must build, typecheck and run when `ee/` is physically absent. Do not fork gateway, shell or update code into `ee/`. The license boundary is separate from process/network trust boundaries.

Introduce a dedicated enterprise composition root/profile rather than interpreting existing `compose`, `local` or `MATRIX_SELF_HOSTED` as a complete deployment contract. Keep existing hosted environment validation and release channel semantics unchanged unless a reviewed shared contract explicitly changes them.

## Offline artifact contract

A proposed `offline-release.json` should bind release version/source commit, edition/profile, architecture/OS baseline, minimum installer/updater versions, schemas and migration compatibility, complete file hashes/sizes, runtime and package dependencies, container image digests where used, models/tokenizers/licenses, SBOM/notices, build provenance and signatures. The separately provisioned trust root must authenticate the manifest before executing any installer, hook, native binary, dependency lifecycle script, model custom code or migration.

Import must reject missing/corrupt/untrusted/wrong-architecture artifacts before changing the machine. Define key rotation/revocation without internet access, explicit downgrade policy, atomic installation, disk preflight, journaled failure/restart recovery and supported rollback/migration limits. Do not equate app rollback with database migration rollback. Keep source/provenance identity and currently selected update subscription separate. Include the source and notices required by the chosen licenses in the export; model redistribution rights need their own review.

Prefer one connected release preparation/export step plus controlled import into the gap. Source rebuilding within the gap requires an additional reproducible toolchain and complete registry/mirror export; promise that only when explicitly included.

## Task packets for the main plan

These are implementation candidates, not completed tasks. Each needs a red/green regression at the real production boundary and an exact-build acceptance artifact.

| Packet | Primary files / proposed additions | Done check |
|---|---|---|
| Deployment inventory | Proposed `packages/contracts/src/deployment-profile.ts`; existing gateway/platform composition and shell providers | All supported profile features have declared authority, endpoint, credential source and egress rule; startup rejects contradictory profile configuration. |
| Offline bundle profile | `scripts/build-host-bundle.sh`, proposed export/verify/import scripts under `scripts/offline/`, installer | Export is complete, no Clerk requirement for standalone build, hosted build still qualifies, tampering/missing content is rejected before mutation. |
| First-boot closure | `scripts/install-server.sh`, selected `matrix-install-*`, database starter and developer-tools unit | Fresh VM with empty caches installs every included component without internet or implicit public-registry fallback. |
| Shared artifact source | `matrix-sync-agent`, `matrix-update-manifest`, `packages/gateway/src/system-update.ts` | Local-media/internal-repository update, power interruption, low disk, bad signature, schema mismatch, intentional downgrade and rollback behave as specified. |
| Local recovery | `matrix-db-backup.sh`, `matrix-restore.sh`, proposed storage/backup adapters | Restore onto a second empty host recovers DB, files, assets, secrets and ownership; corrupt/missing/unreachable backup cases are distinct and safe. |
| Internal storage | `object-storage-config.ts`, deployment-specific startup checks, sync broker | Internal S3 works end-to-end with separate stores and scoped credentials; canonical EU restriction remains tested for hosted provisioning. |
| App supply chain | `manifest-schema.ts`, `build-orchestrator.ts`, `safe-env.ts`, templates | An agent creates/builds/reopens a supported app offline from exported dependencies; an unavailable dependency fails without egress. |
| Telemetry/assets | observability, shell config/layout/PostHog, first-boot telemetry | Server and clean client browser traces show no external request attempts; inherited hosted environment cannot enable outbound telemetry. |
| PKI/time | Installer, nginx config, internal endpoint clients and native trust configuration | Internal CA works; expiry, renewal, clock skew, wrong names and revoked keys produce bounded safe failures. Never qualify with TLS verification disabled. |
| Enterprise composition | Proposed `ee/` root using shared identity/collaboration/storage contracts | Multiuser identity and membership revocation work using only internal authority; no hosted billing/provisioning prerequisite. |
| Speech/connectors | speech adapter seams and explicit capabilities | Excluded features are accurately unavailable; any included internal provider passes the same scope/timeout/resource tests as hosted providers. |

## Parallel development and CI

Use one source line and independent reviewable stacks: shared deployment/adapter contracts first, then runtime, packaging/recovery, enterprise identity/control plane and security qualification. Team ownership can be parallel after contracts are agreed; avoid concurrent edits to oversized composition roots by extracting narrowly scoped wiring files first. Update source-backed inventory when upstream core changes.

Required lanes should run independently and be aggregated at release qualification:

| Lane | Required protection |
|---|---|
| Community/core without EE checkout | Build/typecheck/tests succeed with `ee/` physically absent and no enterprise secrets, declarations or packages. Detect reverse imports, accidental lockfile/runtime coupling and absent optional modules. |
| Existing hosted | Existing Clerk, owner routing, funded AI/speech, provisioning and canonical storage/release checks retain behavior. No fake offline flags used to bypass auth. |
| Standalone connected | Existing installer, local auth/gateway proxy, terminal/editor and data preservation remain operational. |
| Offline community | Pin a real local inference runtime/model; install from empty caches and use server plus clean client firewall/network tracing. Fail if required assertions skip or required tools are missing. |
| Enterprise offline | Internal IdP/storage/collaboration, RBAC, entitlement behavior if selected, administration and restore across supported nodes. |
| Supply chain | Lockfiles, SBOM/notices, hashes/signatures/provenance, model rights and dependency/native binary closure. Test denied redirects, untrusted signatures and mutable dependency sources. |

Do not certify air-gap operation by mocking `fetch` alone or by unplugging after an online warm-up. Block external egress before installation, include browser/client DNS and HTTPS, inspect failed attempts as well as successful calls, and run long enough to exercise timers, token expiry/renewal, first-use lazy assets, tool installation, backup and update checks. Internal allowlists should cover DNS and the customer-approved infrastructure only.

## Acceptance scenarios and failure conditions

- **Install:** empty machine/caches; all external egress denied; validate release first; authenticate over internal TLS and open shell/terminal/editor/default app. Failure means any required download, bootstrap contact or skip.
- **Normal operation:** local AI tool use, create/edit/rebuild app, owner DB/file persistence, scheduled background work, restart/resume and unavailable-capability UI. Check both server and browser traffic.
- **Time and lifecycle:** certificate/token expiry, clock skew, extended offline use, tool first selection and periodic diagnostics. No remote call-home license or flag dependency is allowed in the strict profile.
- **Upgrade:** import exact approved version, migrate, restart and validate owner state. Interrupt each transaction phase; prove deterministic recovery. Reject tampered package, wrong platform, unsupported migration and unapproved downgrade.
- **Recovery:** backup to customer-controlled destination and restore onto a distinct clean host. Verify ownership/permissions/identity, application data, files and credentials; document actual measured RPO/RTO rather than inventing targets.
- **Security boundary:** unauthorized user/org, stale membership, signed actor mismatch, approved connector that changes DNS, untrusted app/package, resource exhaustion and malicious imported artifact fail safely. Security review owns detailed validation; keep exploit recipes outside public planning docs.
- **Surface parity:** Web Desktop, Web Canvas, Electron and native mobile each require live screenshots/recordings and exact build/scenario for included capabilities; a server smoke test cannot qualify a client.

## Remaining evidence and decisions

The following are unresolved until spikes/qualification: complete transitive dependency inventory, minimal OS/CPU matrix, local model capacity and latency, package-template coverage, source-build reproducibility, internal S3 behavior under the selected deployment profile, rollback-safe schema policy, full native distribution/trust paths, enterprise identity schema/ownership model and measured backup RPO/RTO. These are scoped experiments and release gates, not reasons to mark the current source air-gap ready.

The main plan must include a separate `FinnaAI/matrix-os-site` documentation PR under `content/docs/`, a support matrix, operational runbook, upgrade/recovery procedure, precise exclusions and live visual evidence for each included client. No deployment, production change, outbound communication or license alteration was performed by this research.
