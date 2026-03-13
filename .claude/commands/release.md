# Release

Create a tagged release with changelog and push to GitHub. Usage: `/release [patch|minor|major]`

Requested bump: $ARGUMENTS

## Steps

1. Run full test suite: `bun run test`. Stop if tests fail.

2. Show commits since last tag:
   ```
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

3. Categorize commits by Conventional Commit prefix:
   - `feat:` -- New features
   - `fix:` -- Bug fixes
   - `refactor:` / `chore:` / `test:` / `docs:` -- Other changes
   Group them into a changelog.

4. Determine version bump:
   - If `$ARGUMENTS` specifies patch/minor/major, use that
   - Otherwise auto-suggest: any `feat:` = minor, only `fix:` = patch
   - Ask user to confirm

5. Update version in root `package.json`.

6. Commit the version bump: `git commit -am "chore: bump version to v<version>"`

7. Create annotated tag with changelog as message:
   ```
   git tag -a v<version> -m "<changelog>"
   ```

8. Push commit and tag:
   ```
   git push origin main
   git push origin v<version>
   ```

9. Create GitHub release:
   ```
   gh release create v<version> --title "v<version>" --notes "<changelog>"
   ```

10. Report: tag, GitHub release URL, Docker workflow link.

## Rules

- NEVER skip tests before releasing
- NEVER release from a non-main branch without asking
- Follow SemVer strictly (pre-1.0: minor = features, patch = fixes)
- Include all commits in the changelog, grouped by type
