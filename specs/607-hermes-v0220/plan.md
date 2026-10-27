# Hermes v0.22.0 implementation plan

**Goal:** Install the immutable v0.22.0 source and preserve native integrations.
**Architecture:** One bounded resolver reads PM's committed generation. Native
helpers and restricted execution consume its interpreter; upstream PM owns SDKs.
**Tech stack:** TypeScript, Bash, Python, Vitest.
**Spec:** [spec.md](spec.md)

## Tasks

- [x] Add failing environment-resolution tests (legacy, committed, corrupt,
  escaped and missing generations); implement shared resolver and wire native
  execution. Keep restricted source verification before credential-bearing launch.
- [x] Add failing native-metadata tests for the new tuple helper and custom-host
  credentials; adapt read-only selection and private proof binding.
- [x] Update installer contract tests before changing the immutable release,
  supported flags and PM-owned Anthropic extra. Verify ENG-298 overlap and tools.
- [ ] Run isolated official-runtime tests, gateway regressions, typecheck,
  pattern scan and required full unit gate. Record limitations precisely.
- [ ] Coordinate live evidence, sync English results to Linear, publish draft PR,
  monitor current-head review and formal CI. No merge or deployment.

Current execution scope overrides publication steps: local implementation,
synthetic checks, independent local review and a local candidate commit only.
No new installation/download, external CI/review, push, GUI, real credentials,
provider calls, Slack or merge. See [execution-ledger.md](execution-ledger.md)
for completed checks and explicit blockers; the full unit gate is not claimed.

## Review focus

Broken committed records must not select stale venvs; source symlinks must produce
upstream's canonical install key; restricted imports must use the selected ABI;
custom-host tokens must retain endpoint binding; PM updates must retain optional
SDKs and Matrix-owned global tool installs.

## Local continuation: 27 October 2026

See [local-unblock-2026-10-27.md](local-unblock-2026-10-27.md) for the
first-boot staging source fix, actual locked SDK/Git boundary probes, and the
explicit restricted-admission proposal awaiting approval. The preceding scope
paragraph records an earlier phase; current authorization permits bounded local
implementation and isolated dependency verification, while publication and host
operations remain held.
