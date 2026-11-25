# CLI Release Process

The installable Matrix CLI is the `@finnaai/matrix` package in `packages/sync-client`. It is separate from the VPS host-bundle release path: host bundles update customer VPS runtime code, while CLI releases update what users install through npm, Homebrew, `get.matrix-os.com`, and the macOS MatrixSync installer.

## Current Prepared Release

`0.3.23` is the prepared CLI patch release after `0.3.22`. It:

- makes `npm install -g @finnaai/matrix` produce a working `matrix` on Linux and macOS (ENG-300); and
- changes no commands or behavior.

`0.3.22` and earlier fail after `npm install -g`: on Linux the CLI crashes on a missing `zod/v4` module, and on macOS the install aborts while building `fsevents`. The standalone installer (`get.matrix-os.com`) and `pnpm add -g` installs of `0.3.22` are unaffected. After `0.3.23` is published and verified, deprecate `0.3.22` on npm as shown under Rollback.

## Versioning

- Use semver without a leading `v` in `packages/sync-client/package.json`.
- GitHub release tags use `cli-v<version>`, for example `cli-v0.3.0`.
- Do not reuse Matrix OS host-bundle tags such as `v2026.05.12-43` or `v0.X.0` for the CLI.
- Publish only the `@finnaai/matrix` package. The repo root package is private and must not be published.

## Preflight

The CLI bundles the private `@matrix-os/contracts` workspace dependency. Pack
with `node ./scripts/pack-cli.mjs --pack-destination <dir>` from
`packages/sync-client`, as the release workflows do. It runs
`pnpm pack --config.node-linker=hoisted` (plain `npm pack` preserves
`workspace:*`, and a registry-only dependency cannot resolve this private
package), then removes the dependency lists from the bundled contracts
manifest. npm treats a bundled package's dependencies as already bundled when
they sit beside it, which is the layout of `npm install -g` and Homebrew, and
installs empty `zod` and `micromark` directories. The CLI declares the same
packages at the same ranges, so npm installs them for the CLI and contracts
resolves them from there; `pack-cli.mjs` fails if a contracts dependency is
missing from the CLI's own dependencies. Never publish a bare `pnpm pack` or
`pnpm publish` of this package. The dedicated CLI workflow publishes that exact
tarball through npm CLI using trusted-publisher OIDC. Keep the isolated
package-runner check; it verifies bundled contract files and runs the
tarball through `npm exec`, `pnpm dlx`, and `npm install -g` outside the repo.

The CLI also declares `fsevents` under `optionalDependencies`. On
`npm install -g`, npm gives a package that bundles dependencies a hard
dependency on every package installed beside it. `tsx` pulls in `fsevents` as
an optional dependency whose build always fails on macOS (it ships a prebuilt
binary and no `binding.gyp`); normally npm ignores that failure, but the hard
dependency made it fatal and the install aborted. Declaring `fsevents` optional
in the CLI keeps the failure harmless. Do not remove the entry or the
`bundledDependencies` declaration: without the declaration npm prunes the
contracts files on the next `npm install` in a project, and Homebrew's repack
drops them.

The `CLI Install Smoke` workflow checks the packed tarball the way users
install it: `npm install -g` into a clean prefix on macOS and Linux (Node 20
and 24), a project install followed by a second install, and the Homebrew
formula on macOS, each ending in `matrix --version`. `CLI Release` calls it and
will not publish unless it passes; pull requests that touch CLI packaging or
the formula run it too.

Run these from the repo root before dispatching the release workflow:

```bash
pnpm install --frozen-lockfile
pnpm --filter @finnaai/matrix build
pnpm --filter @finnaai/matrix test
pnpm --filter @finnaai/matrix exec node ./scripts/check-publish.mjs
pnpm --filter @finnaai/matrix exec node ./scripts/validate-package-runners.mjs
```

Also verify the version is new:

```bash
npm view @finnaai/matrix version
git tag -l 'cli-v*'
```

## Release

The npm package must trust the GitHub Actions publisher
`HamedMP/matrix-os` / `cli-release.yml` with direct `npm publish` permission.
The packaging job has read-only repository access and uploads the exact
workspace-aware tarball. A separate publish-only job uses setup-node v7,
Node 24, npm 11.5.1 or newer, and job-scoped `id-token: write`; it disables
package-manager caching, does not configure a token-oriented `registry-url`,
and must not receive a long-lived `NPM_TOKEN`. This is the sole exception to
the repository's npm ban: installs still use pnpm and scripts still use bun,
while the npm CLI is invoked only because npm trusted publishing performs the
OIDC exchange during `npm publish`.

Use the manual GitHub Actions workflow named `CLI Release` with `version=0.3.23` and `update_homebrew=true` after this release-preparation PR merges. The workflow:

1. Validates the requested semver, local package version, npm availability, and `cli-v<version>` tag availability.
2. Installs the workspace and runs the sync-client build, tests, and publish-shape check.
3. Publishes `@finnaai/matrix` to npm with provenance.
4. Creates GitHub release `cli-v<version>`.
5. Builds standalone Linux/macOS CLI binaries and attaches them to the GitHub release.
6. Updates `FinnaAI/homebrew-tap` with the npm tarball URL and SHA-256 when `update_homebrew` is enabled.

Manual releases must be dispatched from `main`. If npm publication succeeded
but a downstream release job failed, select the existing `cli-v<version>` tag
as the workflow ref and rerun with `allow_existing_npm=true`; this preserves the
published source revision while completing the GitHub release and Homebrew work.

## Installer Host

`https://get.matrix-os.com` is served by the `matrix-get-worker` Cloudflare
Worker in `packages/get-worker`. It returns `scripts/install.sh` at `/` and
`/install.sh`, and 404 for every other path. The script is bundled into the
Worker at deploy time, so the `Installer Worker` workflow redeploys it on every
push to `main` that changes `scripts/install.sh` or the Worker, then checks that
the live response is byte-identical to the committed script. To redeploy by
hand, dispatch that workflow from `main` with `deploy=true`.

Verify the host at any time:

```bash
curl -fsSL https://get.matrix-os.com | cmp - scripts/install.sh
```

## Post-Release Verification

```bash
npm view @finnaai/matrix version
npm view @finnaai/matrix dist.tarball
npx --yes @finnaai/matrix --version
pnpm dlx @finnaai/matrix --version
brew update && brew info finnaai/tap/matrix
MATRIX_VERSION=0.3.23 sh scripts/install.sh
# The npm global install, checked through its own binary rather than `matrix` on PATH
NPM_PREFIX="$(mktemp -d)"
npm install -g @finnaai/matrix@0.3.23 --prefix "$NPM_PREFIX"
test "$("$NPM_PREFIX/bin/matrix" --version)" = "0.3.23"
rm -rf "$NPM_PREFIX"
matrix --version
matrix update --help
matrix update --check --json
matrix login --help
matrix instance info --json
matrix run --help
matrix forward --help
matrix chats import codex --help
```

For launch-critical cloud coding, test the command path against a live Matrix VPS:

```bash
matrix login --profile cloud
matrix run -it -- claude
matrix run -- ls
matrix forward 5173
```

For standalone binaries, also verify the GitHub release contains:

- `matrix-0.3.23-linux-x64` and its `.sha256`
- `matrix-0.3.23-linux-arm64` and its `.sha256`
- `matrix-0.3.23-darwin-x64` and its `.sha256`
- `matrix-0.3.23-darwin-arm64` and its `.sha256`

For macOS app packaging, also verify the GitHub release contains `MatrixSync-0.3.23.pkg` when the macOS job was enabled.

## Rollback

npm package versions are immutable. If a bad CLI release is published, ship a patch release such as `0.3.23` and update Homebrew through the release workflow. Only deprecate the bad npm version when the replacement is available:

```bash
npm deprecate @finnaai/matrix@0.3.22 "Use @finnaai/matrix@0.3.23"
```
