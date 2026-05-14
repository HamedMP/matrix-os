# Matrix Desktop Release

Desktop release automation lives in `.github/workflows/desktop-release.yml` and
`.github/workflows/desktop-release-foundation.yml`.

The release shape follows Slay Zone's useful pattern: manual channel selection,
multi-platform packaging, reusable workflow foundation, artifact upload, and a
manifest with checksums.

## Channels

Supported workflow channels:

- `dev`
- `canary`
- `beta`
- `stable`

The selected channel is passed as `DESKTOP_RELEASE_CHANNEL` and recorded in
`desktop-release-manifest.json`.

## Local Validation

From the repo root:

```bash
pnpm --dir apps/desktop build
```

The desktop package metadata must include `description`, `author`, and
`homepage`; the Linux `.deb` target fails without the homepage metadata.

For platform packaging, run the platform-specific target on the matching host:

```bash
pnpm --dir apps/desktop build:mac
pnpm --dir apps/desktop build:linux
pnpm --dir apps/desktop build:win
```

After packaging, write the artifact manifest:

```bash
node scripts/release/desktop/write-manifest.mjs apps/desktop/dist dev
```

The manifest excludes blockmap files and records each artifact path, byte size,
and SHA-256 checksum.

## GitHub Workflow

Trigger **Desktop Release** manually and choose a channel. The foundation
workflow:

1. checks out the repo
2. installs pnpm 10.33.4 and Node 24
3. runs `pnpm install --frozen-lockfile`
4. builds `apps/desktop`
5. writes `desktop-release-manifest.json`
6. uploads `apps/desktop/dist/**` as a workflow artifact

## Signing Scope

Current release configuration includes:

- macOS hardened runtime and entitlements
- macOS DMG targets for x64 and arm64
- Windows NSIS targets for x64 and arm64
- Linux AppImage and deb targets

Publish workflows must validate signing/notarization secrets before production
publication. Dry-run build validation can produce unsigned artifacts for review,
but stable publication should not proceed without the required platform secrets.

## Owner Data Invariant

Desktop releases update the native app bundle only. They must never overwrite
owner data in Matrix home, including shell state, workflows, sessions, tickets,
or Symphony records.
