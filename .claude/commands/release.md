# Release

Retired. This command used to push version bumps straight to `main`, which the
PR-only rule forbids. Use the release skills instead:

- Platform service (Cloud Run, `platform-cloud-run.yml`):
  `.agents/skills/release-platform/SKILL.md`
- Customer VPS host bundle, canary then stable (`host-bundle-release.yml`):
  `.agents/skills/release-matrix-stable/SKILL.md`
- Desktop What's New notes: `/release-notes` (`.agents/skills/release-notes/`)

Requested: $ARGUMENTS
