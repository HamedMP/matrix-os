# Contract: Store manifest

A published app's `matrix.json` must parse with the gateway `AppManifestSchema` and also pass `AppStoreManifestSchema` (`packages/contracts/src/app-store.ts`):

| Field | Store rule |
| --- | --- |
| `name` | 1–60 chars |
| `slug` | Ignored. The listing slug governs the installed folder. |
| `description` | 1–240 chars |
| `version` | Strict semver; equals the submitted version |
| `runtime` | `"vite"` |
| `scope` | `"personal"` (default) |
| `build` | Replaced on install with the fixed store build: `install: "pnpm install --frozen-lockfile --ignore-scripts --offline"`, `command: "pnpm exec vite build --base ./ --outDir dist"`, `output: "dist"` |
| `integrations` | `{ required?: AppStoreServiceDecl[], optional?: AppStoreServiceDecl[] }`, where `AppStoreServiceDecl = { service: /^[a-z][a-z0-9_]{0,47}$/, actions: string[1..16] }`, at most 8 services in total, no duplicates |
| `permissions` | Subset of `APP_STORE_PERMISSIONS` (`"ai"`). Other strings are rejected. |
| `storage.tables` | Typed tables (columns use the `app-db` type map). At most 16 tables and 64 columns each. |
| `listingTrust`, `hidden`, `dev`, `serve`, `resources`, `distributionStatus` | Must be absent. The installer sets `listingTrust: "community"`. |

`AppStoreCapabilities` is derived from the manifest as `{ integrations: { required, optional }, permissions, tables: [{ name, columns: [name] }] }`. It is what the consent sheet and the reviewer see.

## Update compatibility

The storage of a new version must be additive relative to the current published version. Every previous table and column must still exist with the same type. New tables, new columns and new indexes are allowed. This is checked by `compareStoreStorage(previous, next)`.

Build commands execute only in the OS-isolated local build service. Fixed argv does not make Vite configuration safe on the host. Lockfile resolution/integrity is validated by the registry broker before mounting a verified read-only dependency cache; reject git/file/workspace/arbitrary tarball dependencies, package-manager hooks and unpinned toolchain commands. Runtime rebuilds must reuse the sandbox or refuse. The approved manifest is verified before gateway-owned installation normalization, and provenance retains both identities.
