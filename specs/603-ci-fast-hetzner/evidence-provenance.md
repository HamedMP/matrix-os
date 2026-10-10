# Generated evidence and build provenance

The Linux benchmark's release-alignment suite rejected its checkout because
E2E screenshots and metadata remained untracked. `readBuildSource` correctly
returns no immutable source identity for a dirty checkout. The host's untracked
files were confined to five generated evidence directories: `output/chat-dock-badge`,
`output/chat-subagent-activity`, `output/chat-tool-details`, `output/eng203`, and
`output/mat524`. Hosted unit reporting also generates `output/ci` JSON artifacts.
`output/playwright` was already ignored and did not cause this failure.

Add six anchored directory ignores for these known artifact destinations. Do not
ignore the whole `output` tree, change production provenance logic, or weaken
release-alignment assertions. Arbitrary untracked source remains dirty, including
`output/unreviewed-source.ts`. Modified tracked files still invalidate source
identity, with the existing narrow release-version stamping exception unchanged.

The dedicated benchmark keeps artifacts between cold and warm passes and runs
its required Electron files in a combined invocation. Unignored evidence can
therefore dirty either test-time provenance or the next Desktop build. Hosted
Electron runs release-alignment before the `mat524` writer; its cold lane was not
proven affected by this particular ordering. Artifact ignores make provenance
independent of generated evidence while preserving the source integrity contract.

## Validation and delivery

TDD uses a real temporary Git checkout and the actual repository ignore rules:
all six artifact paths first appear as untracked and reject provenance; after
committing the artifact ignores, those same files disappear from Git dirtiness
and the source commit is accepted. An uncommitted ignore change and unrelated
untracked source both still reject provenance. Existing source mutation,
expected-SHA, version-stamping, shallow-history, and ancestry-bound contracts
must pass. Linux E2E validation follows independent review; this local layer does
not change the running benchmark, host driver, or image.

The separate public testing-guide deliverable is covered by
[FinnaAI/matrix-os-site PR #224](https://github.com/FinnaAI/matrix-os-site/pull/224),
including generated evidence directories and preserved provenance guarantees.
