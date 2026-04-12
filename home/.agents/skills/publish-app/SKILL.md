---
name: publish-app
description: Publish a Matrix OS app to the Matrix OS App Store. Use when asked to publish, share, distribute, or submit an app to the store, or when making a user's app public.
triggers:
  - publish my app
  - publish to store
  - share my app
  - put on app store
  - make app public
  - submit app
  - distribute app
category: builder
tools_needed:
  - Read
  - Bash
channel_hints:
  - web
  - telegram
examples:
  - publish my calculator app
  - share my todo app with everyone
  - put my budget tracker on the store
composable_with:
  - build-matrix-app
---

# Publish App to Matrix OS Store

Publish a locally-built app from `~/apps/{slug}/` to the Matrix OS App Store so others can discover and install it.

## When to use

- User says "publish my app", "share my app", "put my app on the store"
- User has built an app in `~/apps/{slug}/` and wants others to see it
- User asks to update a previously published app

## Steps

### 1. Verify the app

The app must exist at `~/apps/{slug}/` with a valid `matrix.json`. Check that `name` and `description` are both present -- publishing requires both (see `packages/gateway/src/app-publish.ts`, `validateForPublish`).

```bash
cat ~/apps/{slug}/matrix.json
```

If `description` is missing, read `index.html` or other source files, generate a short description (one sentence), and update the manifest with the Write tool.

### 2. Invoke the `publish_app` IPC tool

The kernel exposes `publish_app` as an MCP tool. Call it with the app directory name:

```
publish_app({ app_name: "{slug}", description?: "...", tags?: ["..."] })
```

Parameters:
- `app_name` (required): the directory name under `~/apps/` (e.g. `calculator`)
- `description` (optional): override the manifest description for the store listing
- `tags` (optional): array of tag strings

The tool runs `validateForPublish` (manifest check + 50MB size limit), prepares a publish payload, and returns the would-be public URL at `matrix-os.com/store/{@handle}/{slug}`.

### 3. Report the URL

Share the returned `matrix-os.com/store/@handle/slug` URL with the user.

## Publish checklist

- [ ] `matrix.json` has `name` and `description`
- [ ] App runs without errors (at least has an `index.html` or a runtime entry)
- [ ] Total app size is under 50MB
- [ ] No secrets in source files (API keys, tokens) -- run `security_audit` first if unsure

## Category guide

Use any of the standard categories (the manifest accepts any string; the store filters by convention):

- `utility` -- calculators, converters, timers, tools
- `productivity` -- todo, calendar, notes, project management
- `games` -- games, puzzles, entertainment
- `developer-tools` -- code editors, API clients, git tools
- `education` -- learning, reference, study aids
- `finance` -- expenses, budgets, investment
- `health-fitness` -- tracking, wellness
- `social` -- chat, profiles, feeds
- `music`, `photo-video`, `news`, `entertainment`, `lifestyle`

## Notes on status

- The current `publish_app` tool validates and prepares the payload locally. A full gallery with reviews, security-audit pipelines, versioning, and org-private distribution is specified in `specs/058-app-gallery/spec.md` but has not yet been implemented.
- Until 058 lands, the underlying store API is the legacy `packages/platform/src/store-api.ts` (`apps_registry` / `app_ratings` / `app_installs` SQLite tables).
