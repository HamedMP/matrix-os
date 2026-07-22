# Terminal Runtime S1/S2 Spike Harness

This directory contains throwaway, production-representative proof code for
spec 109. It is not the production supervisor implementation.

The harness must run on the PR's disposable Ubuntu preview VPS after the exact
PR host bundle is deployed. It verifies `/opt/matrix/bin/zellij --version` is
exactly `zellij 0.44.1`, installs fixed temporary units/support files, runs both
mandatory gates, produces bounded evidence, then stops and resets every spike
unit. The preview VPS is deleted by the existing PR-close/72-hour reaper flow.

## Run

1. Open the upstack PR and add the `preview-vps` label.
2. Wait until Preview VPS reports the PR head bundle deployed.
3. The same-repository PR workflow waits for the exact deployed head and runs
   automatically. After this workflow exists on the default branch, operators
   may also dispatch `Terminal Runtime Spikes` manually with a PR number.
4. Do not treat the workflow as passing unless its validator accepts every S1
   and S2 check and uploads the evidence artifact.

The preview workflow sets `MATRIX_TERMINAL_RUNTIME_SPIKE=1`, so the host bundle
contains this harness only for preview builds. The spike workflow derives the
existing gateway bearer from `PLATFORM_SECRET`, connects to the exact live VPS
with correct `app.matrix-os.com` TLS/SNI, and calls the already bounded
`/api/terminal/run` contract. That fixed command invokes this harness through the
legacy `matrix` sudo grant and a fixed-prefix, detached transient system service;
otherwise the required gateway crash checks would kill the harness itself.
Removing that broad grant remains a later blocked production layer. After the
gateway recovers, a fixed packer returns at most 512 KiB of base64 evidence,
which is validated locally before upload. No SSH credential is required.

## Evidence contract

- maximum 256 files;
- maximum 256 KiB per file;
- maximum 8 MiB total;
- exact PR head SHA and Zellij version;
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
bash -n scripts/spikes/terminal-runtime/launch-remote.sh
bash -n scripts/spikes/terminal-runtime/pack-evidence.sh
node --check scripts/spikes/terminal-runtime/keeper.mjs
node --check scripts/spikes/terminal-runtime/build-evidence.mjs
node --check scripts/spikes/terminal-runtime/verify-evidence.mjs
pnpm exec vitest run tests/scripts/terminal-runtime-spike.test.ts
```
