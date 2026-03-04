---
name: publish-app
description: Publish an app to the Matrix OS App Store. Validates manifest, generates store listing, uploads to registry.
triggers:
  - publish my app
  - publish to store
  - share my app
  - put on app store
  - make app public
category: builder
tools_needed:
  - Read
  - Bash
  - publish_app
channel_hints:
  - web
  - telegram
examples:
  - publish my chess game
  - put my snake game on the app store
  - share my calculator app with everyone
composable_with:
  - build-for-matrix
  - build-html-app
  - build-game
---

# Publish App to Store

Publish a user's app to the Matrix OS App Store so others can discover, install, and fork it.

## Steps

1. **Identify the app**: Ask the user which app to publish, or detect from context. Look in `~/apps/` for the app directory.

2. **Validate**: Check the app has a valid `matrix.json` manifest with `name` and `description`. If missing, help the user add them.

3. **Generate listing**: If no description exists, generate one from the app code. Suggest a category (game, productivity, utility, social, dev, creative) and tags.

4. **Publish**: Use the `publish_app` IPC tool with the app name. This validates the manifest, creates a store entry, and returns a public URL.

5. **Confirm**: Share the public URL with the user: `matrix-os.com/store/@handle/slug`

## Publish Checklist

- [ ] `matrix.json` has `name` and `description`
- [ ] App runs without errors (at least has an index.html)
- [ ] No secrets in source code (API keys, tokens)
- [ ] Size under 50MB

## Category Guide

- **game**: Games, puzzles, entertainment
- **productivity**: Todo, calendar, notes, project management
- **utility**: Calculator, converter, timer, tools
- **social**: Chat, profiles, social features
- **dev**: Developer tools, code editors, API clients
- **creative**: Art, music, design, writing tools
