# Quickstart: Persistent Terminal Runtime Verification

## Layer 1: mandatory spikes

1. Publish the spike PR through Graphite with base PR #1071.
2. Add `preview-vps` only after the normal review gate permits CI. Wait for the
   preview comment and confirm the deployed bundle SHA equals the PR head.
3. The same-repository labeled-PR workflow waits for the exact-head preview and
   starts automatically. Manual dispatch is available for later reruns after
   the workflow has landed on the default branch.
4. The workflow builds and validates the pinned `v0.44.3-matrix.1` source/patch
   recipe, deploys those exact bytes, runs S1 and S2, retrieves a bounded
   artifact, and verifies its build identity and manifest before reporting success.
5. Download the artifact and review:
   - `summary.json` reports `s1=pass` and `s2=pass`;
   - each PID role has the expected cgroup before/after gateway/browser events;
   - stopped/killed units reach `populated 0` and one failure outcome;
   - cache mapping, bounded line counts, command confirmation, corruption
     fallback, deletion, and live-serialization pressure behavior are recorded;
   - `summary.json` reports `privacyScan.status=pass`, and the local validator
     independently scans every listed file before artifact upload.
6. Link the successful workflow run and artifact digest from
   `specs/109-persist-terminal-sessions/evidence/README.md`.

Do not start Layer 2 when either gate fails. Amend the spec and obtain review.

## Focused local checks

```bash
bun run test -- tests/scripts/terminal-runtime-spike.test.ts
bun run check:patterns
```

## Production layers

For every later stack layer:

```bash
bun run typecheck
bun run check:patterns
bun run test
```

React layers additionally require `npx react-doctor@latest shell` and current
Canvas-first screenshot or recording evidence. The final layer repeats the full
disposable-VPS acceptance matrix across two bundles, failed update, and rollback.
