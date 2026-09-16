# DOMAIN: `apps` — app lifecycle, manifests, per-app data bridge

Owns first-party app management (install/fork/publish/upload), manifests,
icons, shell bootstrap payload, project preview, and the per-app Postgres
bridge (`db/`). May import `files`, `git`, `identity`, `_shared`.

## Contents

`apps.ts` · `app-manager.ts` · `app-ops.ts` · `app-manifest.ts` ·
`app-fork.ts` · `app-publish.ts` · `app-upload.ts` · `default-icons.ts` ·
`icon-routes.ts` · `native-app-storage.ts` · `preview-manager.ts` ·
`shell-bootstrap.ts` · `db/` (`app-db*.ts`, `bridge-sql.ts`)

## Public package surface

`@matrix-os/gateway/app-publish`, `/app-fork`, `/app-manifest` (consumed by
`packages/kernel/src/ipc-server.ts`) — keep these paths stable.

## Decision log

- 2026-09-16 (Phase 1-A3/W3): `preview-manager.ts` placed here, not its own
  domain — previews are app lifecycle; split later if it grows.
- `shell-bootstrap.ts` placed here (closest owner: app-surface
  composition); revisit if a shell domain forms.
- `native-app-storage.ts` placed here, not `files` — app-scoped storage
  policy, not generic file ops.
- Package `exports` updated to the new paths (kernel consumer verified).
