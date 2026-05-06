---
name: matrix-debug-app
description: Debug Matrix OS app failures including needs_build responses, missing dist bundles, broken matrix.json manifests, icon 404s, console errors, and integration proxy issues.
version: 1.0.0
author: Matrix OS
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Matrix OS, debugging, apps, Vite, console]
    related_skills: [matrix-app-builder, matrix-integrations]
---

# Matrix App Debugging

## When to Use

Use this when a Matrix app shows an error, blank screen, `needs_build`, missing icons, CORS failures, or console errors.

## First Checks

```bash
cd ~/apps/<slug>
test -f matrix.json
test -f package.json
test -f dist/index.html
```

If `dist/index.html` is missing, build the app:

```bash
pnpm install
pnpm build
test -f dist/index.html
```

## `needs_build`

`{"error":"needs_build","status":"needs_build"}` means the gateway found a Vite app manifest but no usable build output.

Fix:

1. Check `matrix.json` has `runtime: "vite"` and `entry: "dist/index.html"`.
2. Run `pnpm install`.
3. Run `pnpm build`.
4. Verify `dist/index.html`.
5. Reload the app window.

## Manifest Checks

Good baseline:

```json
{
  "name": "Whiteboard",
  "description": "Collaborative drawing and notes",
  "runtime": "vite",
  "entry": "dist/index.html",
  "framework": "react",
  "category": "productivity",
  "icon": "whiteboard",
  "version": "1.0.0"
}
```

Avoid stale fields from old app formats such as `type: "html-app"` or `type: "react-app"` unless the current gateway explicitly supports them.

## Console Error Triage

- `needs_build`: build output is missing.
- `404 /icons/<slug>.png`: default icon asset missing or manifest points at a non-existent icon.
- `404 app bundle`: `entry` or Vite `base` is wrong.
- `CORS` from provider API: app is calling a provider directly. Use Matrix integration routes.
- `401 /api/auth/ws-token`: user is not authenticated or the route is being called from the wrong shell context.
- `Clerk failed to load clerk.example.com`: stale environment or image build used placeholder Clerk config.

## Icon Fixes

- Use committed default icon assets for built-in apps.
- Manifest `icon` should be a slug, not an arbitrary URL.
- Verify the resolved icon path exists in Matrix's system icons.
- Do not rely on runtime image generation for default icons.

## Integration Errors

Customer VPSes should proxy integration requests to platform. If `/api/integrations` returns 404:

1. Check gateway env has internal platform URL/token.
2. Check platform has Pipedream credentials.
3. Do not copy Pipedream secrets into the customer VPS as a workaround.

## Verification

Before saying fixed:

```bash
cd ~/apps/<slug>
pnpm build
test -f dist/index.html
```

Then reload the app and confirm:

- The app renders.
- Browser console has no app errors.
- Network tab has no bundle 404s.
- Any integration calls go through Matrix routes.
