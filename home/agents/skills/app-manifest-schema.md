# Matrix OS app manifest schema (`matrix.json`)

Every app under `~/apps/{slug}/` must ship a `matrix.json` that matches the
schema in `packages/gateway/src/app-runtime/manifest-schema.ts`. If a
manifest is missing a required field or the slug doesn't match the folder
name, the gateway returns 500 from `/api/apps/{slug}/session` and the iframe
never gets past the "Refreshing session..." interstitial.

## Required fields (all apps)

```json
{
  "name": "Human-readable app name",
  "slug": "my-app-slug",
  "version": "1.0.0",
  "runtime": "static | vite | node",
  "runtimeVersion": "^1.0.0",
  "listingTrust": "first_party"
}
```

Rules:

- **`slug`** must match `^[a-z0-9][a-z0-9-]{0,63}$` **and must equal the
  directory name**. `cp -r _template-next my-app` won't work unless you
  also change `matrix.json`'s `slug` to `"my-app"`.
- **`version`** must be semver (`X.Y.Z` or `X.Y.Z-suffix`).
- **`runtimeVersion`** must be a semver range (`^1.0.0` is standard).
- **`runtime`** is one of `static` (pre-built files under `/`), `vite`
  (SPA with build step), or `node` (long-running server).
- **`listingTrust`** gates distribution. First-party (shipped with the OS
  or installed by the user themselves) gets `"first_party"`. Omitting it
  makes `distributionStatus` fall through to `blocked` → session 403.

## Runtime-specific fields

**`runtime: "static"`** — no other required fields. Files served from the
app directory as-is.

**`runtime: "vite"`** — requires `build`:
```json
"build": {
  "command": "vite build",
  "output": "dist"
}
```

**`runtime: "node"`** — requires `build` and `serve`:
```json
"build": {
  "command": "next build",
  "output": ".next"
},
"serve": {
  "start": "next start -p $PORT",
  "healthCheck": "/api/health",
  "startTimeout": 15,
  "idleShutdown": 300
}
```

## What NOT to put in the manifest

- **`distributionStatus`** — computed server-side. The schema rejects any
  manifest that declares it.

## Validating before shipping

From the repo root:
```bash
pnpm exec vitest run tests/gateway/seed-manifests.test.ts
```
That test parses every `home/apps/*/matrix.json` through the real Zod
schema and fails loudly on any mismatch.

## Legacy (pre-spec-063) manifests

Apps written before the 063 app-runtime work often lack `slug`,
`runtimeVersion`, and `listingTrust`. `scripts/migrate-apps-063.ts`
backfills them for an existing user home. If you open a pre-063 app that
errors with `invalid_manifest`, run the migration.
