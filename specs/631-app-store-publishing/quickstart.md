# Quickstart and Qualification: App Store Publishing

## Prerequisites

Use a disposable supported VPS and exact host-bundle version. Configure platform store flag, reviewer Clerk allowlist, bundles storage and an explicitly provisioned Ed25519 signing key; use authenticated per-VPS platform connections. Keep credentials in private configuration. There is no platform builder service, builder secret or dist download.

Provision the gateway OS sandbox adapter, pinned toolchain and restricted registry broker. Prove that sandbox code cannot read host home/env/sockets or access the network, resource limits terminate the entire job, and unavailable isolation refuses all execution. Publisher verification must use this same adapter. Starting the normal host dev services does not establish this prerequisite.

## End-to-end Scenario

1. Open Gallery Publish in Codex's in-app browser. Select the owner app; inspect provider disclosure and explicitly consent before scrubbed source goes to the selected AI provider.
2. Wait for snapshot/scan/generalization/isolated verification. Review exact changes/findings/listing; choose license and separately consent to Matrix submission. Confirm no platform upload before this step.
3. As an allowlisted reviewer inspect source, capabilities, findings, prior diff and reports. Approve; source becomes published immediately with signed approval, without a platform build.
4. As a different installer identity open Community/detail, inspect integrations/actions/permissions/tables, consent, install and poll local queued/building status. Verify authenticated source grant, signature/digests, offline isolated build and installed source plus local output. Rate after success; count one download across retry/reinstall.
5. Repeat with malicious Vite config, missing sandbox, altered source/signature and interrupted update. Each fails safely; prior install/data survives and no successful-install metric is recorded.

## Tests and Evidence

Run focused contract, platform, gateway/local-isolation, kernel, Gallery, Web, Electron and Native Mobile suites using repo-pinned tools; then typecheck/pattern checks and production shell build. Use real integration tests across auth/intake/review/grant/local-build/install/metrics, not only mocked services.

Capture each of Web Desktop, Web Canvas, Electron Desktop, Web Mobile and Native Mobile separately, including screenshots and a recording. Use supported native dev client/device, not Expo Go. Annotate exact commit/build, scenario and fixture/bypass limitations. Native Mobile has an installed-app runtime and cannot be blanket N/A. Any narrow N/A needs architectural rationale and reviewer approval.

Attach actual evidence links to PRs and Slack `#tech` with [ENG-322](https://linear.app/matrix-os/issue/ENG-322/add-reviewed-community-app-publishing-to-matrix-gallery)/stack links, then backlink the Slack permalink. Missing access/evidence is a review-readiness blocker. Complete the separate `FinnaAI/matrix-os-site` public documentation PR before declaring the full deliverable ready.
