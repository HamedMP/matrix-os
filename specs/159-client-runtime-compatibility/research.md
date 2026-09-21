# Desktop / VPS release eligibility and installation research

> September 21 revision: this file preserves the September 18 source evidence. The current plans adopt the subsequent meeting decision of coordinated stable releases, with our implementation scope centered on the update modal and orchestration. This historical research is not a live production audit or the current release-policy recommendation.

Date: 2026-09-18. Source baseline: `origin/main` at `ba8ca7e88`. This is bounded source-code research for the compatibility redesign, not a live production audit. No releases, deployments, user accounts, or permissions were changed. Renderer compatibility/modal behavior is covered separately by the design plan.

## 1. The present source does not explain the reported ordinary-user restriction

The user reports that ordinary users cannot access the dev VPS bundle, while a newer Electron Desktop keeps suggesting an update. Treat stable-only access for ordinary users as a product requirement. Do not describe the present source as already enforcing that requirement:

- Both current System settings implementations enumerate `stable`, `canary`, `beta`, and `dev`; both render every option. Web Settings does not hide System; Electron Settings renders its complete section list. There is no ordinary/internal user branch in these inspected controls. [Web channel list and rendering](../../shell/src/components/settings/sections/SystemSection.tsx#L106-L110), [Web rendering](../../shell/src/components/settings/sections/SystemSection.tsx#L471-L483), [Web hidden sections](../../shell/src/components/Settings.tsx#L73-L83), [Electron channels](../../desktop/src/renderer/src/features/settings/sections/SystemSection.tsx#L8-L8), [Electron rendering](../../desktop/src/renderer/src/features/settings/sections/SystemSection.tsx#L252-L261), [Electron sections](../../desktop/src/renderer/src/features/settings/SettingsView.tsx#L44-L56).
- Gateway `/api/system/update` and `/api/system/releases` select a syntactically valid requested channel, otherwise environment/installed/default stable. These handlers do not apply account-specific channel entitlements. Installation accepts either a channel or an explicit version. This is an observation about release policy inside authenticated runtime routes, not a claim that gateway authentication is absent. [Gateway routes](../../packages/gateway/src/server.ts#L3977-L4010), [update target handling](../../packages/gateway/src/server.ts#L4025-L4074), [channel resolver](../../packages/gateway/src/system-update.ts#L76-L97), [target parser](../../packages/gateway/src/system-update.ts#L100-L136).
- Platform host-bundle metadata and bundle download handlers are mounted as public distribution routes. Read handlers do not call the admin checker; register/promote mutations do. Channel manifests accept all four channels. The route comment explicitly identifies the distribution as public. [Platform mounting](../../packages/platform/src/main.ts#L393-L413), [read release list](../../packages/platform/src/host-bundle-routes.ts#L181-L213), [public bundle/channel handler](../../packages/platform/src/host-bundle-routes.ts#L407-L463), [admin mutation check](../../packages/platform/src/host-bundle-routes.ts#L240-L253).

**Conclusion / uncertainty:** the reported restriction could belong to a deployed older implementation, release availability, configuration, or another policy layer. It was not reproduced or established by this read-only research. The redesign needs an explicit authoritative eligibility policy; hiding a selector is neither candidate filtering nor install authorization. If private dev artifact access is a requirement, current public distribution paths also need migration, while preserving cloud-init and host-agent service authentication.

## 2. Channel, artifact identity, and eligibility are different data

| Concept | Present source of truth | Design consequence |
| --- | --- | --- |
| Installed VPS artifact | `/opt/matrix/release.json`, carrying release version, build channel, commit, and build time | Artifact provenance does not determine which releases a user may install. |
| VPS update subscription | `/opt/matrix/env/host.env` `MATRIX_UPDATE_CHANNEL`, then environment, then release channel, then stable | Do not overwrite subscription when reporting the artifact's original build channel. |
| Current channel tip | `host_bundle_channels` | A mutable recommendation pointer, not complete membership history. |
| Releases promoted into a channel | `host_bundle_release_channels` | Suitable input to an eligible candidate catalog, together with explicit withdrawal/revocation state. |
| Desktop update subscription | environment override or compiled channel; generic GitHub `desktop-<channel>` feed | Independent of the connected runtime's subscription and account policy. |

Sources: [installed release and persistent subscription reads](../../packages/gateway/src/system-info.ts#L289-L329), [system info precedence](../../packages/gateway/src/system-info.ts#L407-L422), [promotion transaction](../../packages/platform/src/db.ts#L4524-L4557), [Desktop feed resolution](../../desktop/src/main/update-config.ts#L40-L79).

The platform's channel-filtered release list joins **promotion history**, not only the current pointer. Promotion updates the current pointer and inserts a `(channel, version)` membership record in one transaction. `HostBundleReleaseRecord.channel` remains the registration/build-channel field; re-registration does not rewrite immutable artifact fields. Therefore a bundle originally built on dev can be legitimately promoted to stable without changing bytes or the original build channel. A stable-only eligibility check must inspect authorized promotion membership, not reject merely because the release's original `channel` was dev. A revoked artifact must still be removable from eligibility even if historical membership remains. [List query](../../packages/platform/src/db.ts#L4488-L4511), [promotion transaction](../../packages/platform/src/db.ts#L4524-L4557), [artifact upsert immutability](../../packages/platform/src/db.ts#L4435-L4472), [record mapping](../../packages/platform/src/db.ts#L2881-L2923).

One existing consistency issue to account for: `/api/system/info` reads the persistent host environment file, whereas `/api/system/update` resolves its default using the process environment plus installed release channel. A unified resolver should use the same effective subscription throughout. This is a source-level inconsistency; live stale-process behavior was not tested. [Info precedence](../../packages/gateway/src/system-info.ts#L410-L413), [update route precedence](../../packages/gateway/src/server.ts#L3977-L3983).

## 3. Both release pipelines are independent already; compatibility metadata is missing

Host-bundle manifests currently contain artifact identity, source provenance, time, hash/size, severity, update type, changelog, and incremental files. The platform registration schema and serialized response do not carry a client/runtime contract or capability declaration. Desktop's release manifest carries version/channel/commit and artifact hashes, also without compatibility requirements. Thus neither release catalog can currently prove that its candidate repairs a protocol/capability mismatch before installation. [Host manifest generator](../../scripts/host-bundle-release.mjs#L21-L42), [host manifest construction](../../scripts/host-bundle-release.mjs#L67-L103), [platform schema/response](../../packages/platform/src/host-bundle-routes.ts#L43-L108), [Desktop release manifest](../../scripts/release/generate-desktop-release-manifest.mjs#L37-L60).

Host `main` pushes publish dev; tags default to canary. Explicit dispatch chooses stable/beta/canary/dev. The current dev gate defaults to building regardless of changed paths. Publication is separate from fleet deployment, which requires explicit dispatch plus `deploy_after_publish`; even then its success response proves triggering, not finished installation. [Host workflow triggers](../../.github/workflows/host-bundle-release.yml#L1-L55), [channel resolution](../../.github/workflows/host-bundle-release.yml#L233-L246), [build gate](../../scripts/ci/dev-bundle-gate.sh#L4-L12), [deployment trigger](../../.github/workflows/host-bundle-release.yml#L383-L415).

Desktop uses `desktop-v*` tags or explicit dispatch; canary has its own schedule. It publishes immutable release assets, then moves the channel pointer. Pointer manifests contain URLs to the immutable release assets. These workflows are independently triggered; the inspected publication stages contain no cross-product compatibility admission check. [Desktop triggers](../../.github/workflows/desktop-release.yml#L1-L30), [canary triggers](../../.github/workflows/desktop-release-canary.yml#L1-L13), [Desktop publication order](../../.github/workflows/desktop-release.yml#L200-L238), [immutable asset URLs](../../scripts/release/prepare-desktop-channel-manifests.mjs#L48-L79).

**Design inference:** keep independent product release numbers and source SHAs. Add immutable compatibility declarations bound to artifact hashes and validate them in CI and channel promotion. Restoring protocol-only UI decisions is necessary but insufficient: without contract conformance tests, developers can change API/event behavior without updating a protocol constant, and without candidate declarations the updater cannot prove a suggested target resolves the issue.

## 4. Exact VPS targets exist; exact Desktop admission does not

### VPS

The gateway already resolves a mutable channel to an immutable version **before** starting an install and returns that version as the completion predicate. Explicit versions are passed through after format validation; the current path does not separately prove version existence, user eligibility, or compatibility before starting. It invokes `matrix-update` with that exact target. [Target resolution](../../packages/gateway/src/system-update.ts#L161-L181), [gateway invocation/response](../../packages/gateway/src/server.ts#L4035-L4071), [updater spawning](../../packages/gateway/src/system-update.ts#L413-L442).

The host launcher persists `.update-version`; the sync agent prioritizes that file, fetches `/system-bundles/releases/<version>.json`, and rejects metadata whose version differs from the requested version. This is a useful existing foundation for a reviewed repair plan. [Launcher](../../distro/customer-vps/host-bin/matrix-update#L17-L27), [trigger preparation](../../distro/customer-vps/host-bin/matrix-sync-agent#L941-L979).

### Electron Desktop

The updater selects a single generic channel feed and immediately downloads an available version. `update:install` has an empty request; there is no expected release ID or immutable plan ID. Install rechecks the mutable channel and proceeds only when the staged version equals the freshly returned version. That avoids installing stale feed contents, but proves neither runtime compatibility nor that the newly selected candidate is the one the user reviewed. [Feed setup/download](../../desktop/src/main/updates.ts#L148-L177), [install recheck](../../desktop/src/main/updates.ts#L239-L249), [IPC request](../../desktop/src/shared/ipc-contract.ts#L446-L456), [IPC handler](../../desktop/src/main/ipc/handlers.ts#L389-L391).

Normal application quit is another installation entry point: if the updater is ready, `createUpdateAwareBeforeQuit` intercepts quit and calls the same `install()`. Although `electron-updater.autoInstallOnAppQuit` is disabled, the application implements this behavior itself. A renderer-only repair modal check would not cover this path. [Auto-install setting](../../desktop/src/main/updates.ts#L153-L157), [quit behavior](../../desktop/src/main/update-quit.ts#L15-L36), [main wiring](../../desktop/src/main/index.ts#L312-L322).

**Required plan property:** one main-process installation admission path for modal/sidebar/normal quit. It must validate immutable target ID/hash, compatibility requirements, eligibility, active runtime generation, withdrawal state, and freshness. Feed changes invalidate/recompute a plan; they must not silently substitute a different target. Downloads may be staged separately from approval to install. Exact alternate Desktop candidates or downgrade repair would require an intentional extension; the present API only installs its selected current-feed candidate.

## 5. All automatic paths need compatibility admission

VPS passive polling compares the channel candidate with the installed version, ignores recognized older releases, and automatically applies candidates marked security or `updateType=auto`. Publication of such a release can therefore trigger installs even when the workflow's fleet deployment option was false. Compatibility safety must live in channel promotion and host update admission as well as the Electron UI. [Passive polling](../../distro/customer-vps/host-bin/matrix-sync-agent#L993-L1037), [severity default](../../scripts/host-bundle-release.mjs#L38-L42).

The gateway's current `updateAvailable` calculation answers only a release-order question: equal commits suppress updates; otherwise date version/build time/different version determine availability. It is not evidence that the installed client and runtime are compatible, that an update is needed for compatibility, or that the latest release can repair it. [Comparison](../../packages/gateway/src/system-update.ts#L222-L243), [check response](../../packages/gateway/src/system-update.ts#L331-L355).

## 6. Release ordering implications for the proposed design

These are design conclusions from the source evidence above, not descriptions of deployed behavior:

1. **Desktop-only compatible change:** advance the Desktop channel after validating against supported eligible runtime contracts. No VPS stable release is required merely to match its SHA.
2. **Runtime-only compatible change:** promote/update the runtime after validating currently supported Desktop contracts. No Desktop release is required merely to match its SHA.
3. **New optional runtime capability:** release additive runtime support first when practical; a new Desktop may ship earlier if it hides/disables that capability with truthful copy and its core remains compatible.
4. **New required runtime capability:** do not promote the Desktop to an audience until the runtime repair target is genuinely available and installable for that audience, or a backward-compatible bridge Desktop exists. A dev-only target cannot satisfy ordinary stable-user admission.
5. **Breaking change:** preserve an overlap bridge and calculate a safe order. Do not assume VPS-first universally: sometimes client-first is safe, sometimes runtime-first, sometimes neither single step is safe. Block publication/installation if no valid intermediate state exists; do not send users into an update loop.
6. **Repair plans:** distinguish compatible/current, compatible/optional update, limited optional capability, required update with an installable exact plan, known incompatible with no eligible repair, and metadata/check unavailable. “Up to date” describes a particular selected channel; it must never be used as the compatibility result.
7. **Policy scope:** ordinary stable-only users, explicitly entitled preview users, and operators need distinct server-enforced policy. Eligibility should combine audience/channel memberships, OS/architecture, rollout cohort, artifact availability, installer constraints, and withdrawal state. Revalidate at execution; do not infer authority from client-provided roles or UI visibility.
8. **Migration:** add descriptors to both immutable release formats and platform records first, with explicit unknown/legacy treatment. Preserve public installer/bootstrap access through a deliberate service-auth migration if the intended policy restricts dev bytes themselves. Add an emergency/operator escape hatch separately from ordinary self-service.

## 7. Verification gaps and plan acceptance tests

The research did not inspect production entitlements, live channel pointers, private object-store settings, users' installed versions, or reproduce the modal on a real account. Those checks belong in implementation validation before asserting the production root cause is fully resolved.

Tests needed from this release-lifecycle research:

- Stable ordinary user + newer Desktop + only dev runtime candidate: no impossible upgrade call to action; dev cannot become an executable target through a crafted version request.
- Different SHAs with equal compatible contracts: no compatibility warning; optional update state remains independent.
- Same SHA with changed build/config-dependent capability: candidate declaration/readiness still determines support; SHA equality cannot bypass compatibility checks.
- Dev-built immutable bundle promoted to stable: stable membership makes it eligible without rewriting provenance; withdrawal removes it from candidates.
- Channel pointer changes after review or before app quit: no silent target replacement; re-evaluate the exact candidate and plan.
- Sidebar, compatibility modal, manual check, normal quit, VPS security polling, and explicit host install all enforce the relevant admission boundary.
- Exact VPS target returns success only after installed and **running** identities match the plan and the live compatibility handshake succeeds; publication and trigger acknowledgement are insufficient.
- Multi-runtime Desktop switch during a plan: invalidate the old runtime-scoped plan and never apply its VPS mutation to a newly selected computer.
- Legacy/unknown metadata or network errors: do not misreport incompatibility, update availability, or successful repair.
