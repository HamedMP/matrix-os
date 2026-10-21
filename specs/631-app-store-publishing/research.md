# Research and Decisions: App Store Publishing

**Ticket**: [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery). Recovered source history is context, not verification. The confirmed local continuation decision supersedes the old platform-builder plan.

## R1. Privacy and consent

Preparation is local to the publisher VPS; no platform upload occurs before final source/listing/license consent. AI generalization sends scrubbed draft source to the owner-selected external provider, requiring a separate prior disclosure and consent. Do not promise that source never leaves the machine during AI preparation or that pattern scanning finds all secrets.

## R2. Confined AI

Use Agent SDK V1 `query()` with file tools only, no shell/MCP/network tools, bounded turns/budget/time and realpath/symlink-safe checks for all paths. SDK provider traffic is the disclosed exception to no agent-tool network access. `allowedTools` is auto-approval, not restriction; full dispatcher with owner-wide bypass is unsuitable. Verify undocumented SDK behavior with a throwaway spike before implementation. If provider access/consent is unavailable, deterministic scrub/scan may proceed but AI reports unavailable.

## R3. Scrub and source format

Drop `.env*` and replace detected secrets before provider transmission; show redacted findings. Use deterministic gzip JSON `matrix-app-bundle/1` with bounded file map, exact compressed digest/length and per-file SHA-256. Source contains full generalized project, lockfile and license; excludes dependencies/dist/logs. No tar links or host paths.

## R4. Build location: each installer VPS

Hamed explicitly chose local builds on every installer VPS and full source delivery. The platform reviews and publishes source directly; remove platform dist builder, jobs, lease callbacks and builder secret. A temporary folder, `--ignore-scripts` or scrubbed environment is insufficient: Vite config/dependencies execute arbitrary code.

Use one shared local build service for publisher verification and installer/update builds. Require verified OS isolation (dedicated non-root UID, mount/user/PID/network namespaces, no host home/credentials/sockets, read-only pinned toolchain, bounded staging/output/resources, full teardown). A restricted registry broker outside submitted-code execution fetches exact lockfile-pinned packages and validates integrity. Submitted code receives no network; install is frozen/offline with scripts disabled, and Vite is offline with fixed argv. Reject git/file/workspace/arbitrary URL dependencies and hooks. Fail closed when isolation is unavailable; never run Vite directly on owner host. Local output digests record local provenance, not cross-VPS reproducibility.

## R5. Approval integrity

Staff approval signs a domain-separated canonical source/version/manifest/capability identity with Ed25519 and publishes atomically. Authenticated platform status provides a bounded trusted public-key ring; bundles never supply trusted keys. Provisioning signing keys is required and missing configuration fails closed. The installer verifies signature, source bytes and consent before building.

## R6. Identity and persistence

Reviewers are allowlisted Clerk IDs derived from authenticated per-VPS token handles; no body-supplied identities. Use separate `app-store` Postgres/Kysely migration scope. CAS state transitions and listing row locks protect current version/semver/counters under concurrent absent-row inserts. Gateway-owned provenance, not editable manifest, determines community trust. Authenticated launch identity must bind gateway authorization; stamping a body field alone is insufficient.

## R7. Runtime surfaces verified in current source

Web and Electron have separate app bridge implementations. Native Mobile also has installed-app runtime in `apps/mobile/app/app-preview/[app].tsx` and `components/AppRuntimeFrame.tsx`, using `lib/app-capability-bridge.ts`; that broker currently supports db/capability/AI kinds and is not the Web Gallery fetch bridge. Therefore the historical Native Mobile N/A claim is false. Plan explicit native Gallery support and device evidence; any specific excluded flow requires architectural rationale and recorded reviewer approval.

## R8. Metrics and scope

Downloads count unique successful installer identities; active installs are current installs; average is rating_sum/rating_count. No metric before successful local publication; retries are idempotent. Stars only, no text reviews/upvotes/paid apps/org publishing for v1. Full source uses a required publisher license. Remove unsafe legacy `/api/store` routes but retain legacy tables for a separate data-lifecycle decision.

## R9. Review deliverables

One verified ENG-322 ticket covers the native stack; every layer links it and this spec. Capture actual screenshots/recordings per affected surface with exact commit/build and fixture limitations, put evidence in PRs and Slack `#tech`, backlink Slack permalinks. Missing runtime access blocks review readiness. Public docs require a separate PR in private `FinnaAI/matrix-os-site` under `content/docs/`; local docs alone are insufficient.
