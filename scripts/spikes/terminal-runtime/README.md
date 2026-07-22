# Terminal Runtime S1/S2 Spike Harness

This directory contains throwaway, production-representative proof code for
spec 109. It is not the production supervisor implementation.

The harness must run on the PR's disposable Ubuntu preview VPS after the exact
PR host bundle is deployed. It verifies `/opt/matrix/bin/zellij --version` is
`zellij 0.44.3` and verifies the installed binary metadata is exactly
`v0.44.3-matrix.1` from the checked-in authoritative build record (pinned source, patch, Rust 1.92.0, musl target, fixed exclusive build root, and candidate
binary SHA-256 `b7154142f44d265932d342f23e5d7beb7933ab878e912131098501ca314df403`). The build fixes and remaps its source, Cargo registry, target, generated-file, and vendored-C build paths; a clean `ubuntu-24.04` builder must reproduce those exact bytes before the VPS can install them. Every Zellij-bearing bundle stages the complete prior binary/metadata snapshot inside the stopped current app, then carries that snapshot into the updater's one-level rollback generation with the app-directory rename. An ordinary replacement removes stale candidate metadata after copying its binary; candidate-bearing bundles additionally validate the bundled digest, atomically rename the executable into place, and validate the installed digest. Failed or explicit application rollback restores both prior Zellij files before the gateway restarts. The spike then installs fixed temporary units/support files, runs both mandatory
gates, produces bounded evidence, and stops/resets every spike unit. The preview
VPS is deleted by the existing PR-close/72-hour reaper flow.

## Run

1. Open the upstack PR and add the `preview-vps` label.
2. Wait until Preview VPS reports the PR head bundle deployed.
3. The same-repository PR workflow waits for the exact deployed head and runs
   automatically. After this workflow exists on the default branch, operators
   may also dispatch `Terminal Runtime Spikes` manually with a PR number.
4. Do not treat the workflow as passing unless its validator accepts every S1
   and S2 check and uploads the evidence artifact.

The preview workflow builds the patched binary from the SHA-256-pinned 0.44.3
source archive and reviewed patch, runs its upstream regression tests, and passes
it to the host bundle through a spike-only override. Normal production bundle
defaults are unchanged by this PR. The workflow also sets
`MATRIX_TERMINAL_RUNTIME_SPIKE=1`, so the host bundle contains this harness only
for preview builds. The spike workflow derives the
existing gateway bearer from `PLATFORM_SECRET`, connects to the exact live VPS
with correct `app.matrix-os.com` TLS/SNI, and calls the already bounded
`/api/terminal/run` contract. That fixed command invokes this harness through the
legacy `matrix` sudo grant and a fixed-prefix, detached transient system service;
otherwise the required gateway crash checks would kill the harness itself.
Removing that broad grant remains a later blocked production layer. After the
gateway recovers, a fixed packer returns at most 512 KiB of base64 evidence,
which is validated locally before upload. No SSH credential is required.

The viewport assertion is captured from the named recovered pane while its
command is still held. Only after that comparison does the probe dismiss the
gate to a fresh shell and count the complete restored history. This prevents
new prompt output from being mistaken for a resurrection failure while still
proving that the original command never ran.

## Evidence contract

- maximum 256 files;
- maximum 256 KiB per file;
- maximum 8 MiB total;
- exact PR head SHA plus Zellij source, patch, toolchain, target, and binary identity;
- strict complete S1/S2 check maps;
- relative cache paths and aggregate sizes only;
- no terminal contents, credentials, IP addresses, owner-home paths, names, or
  provider data;
- SHA-256 for every listed file and the summary.

`verify-evidence.mjs` rejects unlisted files, traversal, symlinks, hard links,
size/count mismatches, digest mismatches, invalid UTF-8, sensitive patterns, or
any failed/missing gate.

## Local validation

```bash
bash -n scripts/spikes/terminal-runtime/run-remote.sh
bash -n scripts/spikes/terminal-runtime/build-zellij.sh
bash -n scripts/spikes/terminal-runtime/launch-remote.sh
bash -n scripts/spikes/terminal-runtime/pack-evidence.sh
node --check scripts/spikes/terminal-runtime/keeper.mjs
node --check scripts/spikes/terminal-runtime/build-evidence.mjs
node --check scripts/spikes/terminal-runtime/verify-evidence.mjs
pnpm exec vitest run tests/scripts/terminal-runtime-spike.test.ts
```
