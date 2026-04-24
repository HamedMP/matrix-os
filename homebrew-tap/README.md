# homebrew-tap (staging)

Staging copy of the `FinnaAI/homebrew-tap` repository. Lives inside this
monorepo during bootstrap so the formula is version-controlled alongside
the release pipeline.

The release workflow (`.github/workflows/release.yml` → `homebrew` job)
checks out `FinnaAI/homebrew-tap` separately, rewrites `Formula/matrix.rb`
with the latest npm tarball URL + sha256, and pushes.

When the external tap repo is bootstrapped for the first time, copy this
formula over:

```bash
cp homebrew-tap/Formula/matrix.rb /path/to/FinnaAI/homebrew-tap/Formula/
```

After that, day-to-day edits happen in the tap repo, not here.
