# Ship

Test, push to GitHub, and optionally tag a release.

## Steps

1. Run `bun run test` to verify nothing is broken.
2. Check `git status` for uncommitted changes. If any, ask the user whether to commit first.
3. Check `git log @{u}..HEAD --oneline` for unpushed commits. If none, report "nothing to push" and stop.
4. Push to origin: `git push origin <current-branch>`.
5. If on `main`, show commits since last tag: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`.
6. Ask: "Want to tag a release? (patch/minor/major/skip)"
7. If tagging:
   - Read current version from `package.json`
   - Bump accordingly
   - Create annotated tag: `git tag -a v<version> -m "<summary of changes>"`
   - Push tag: `git push origin v<version>`
   - Report: this triggers the Docker workflow which builds, pushes to GHCR, and deploys to VPS
8. Check CI status: `gh run list --branch <branch> --limit 1`
9. Report final summary: commit SHA, tag (if any), CI status, workflow URL.

## Rules

- NEVER force push
- NEVER push to main without running tests first
- Follow Conventional Commits for tag messages
- Follow SemVer: feat = minor, fix = patch, breaking change = major
