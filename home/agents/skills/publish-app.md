---
name: publish-app
description: Publish an app to the Matrix OS App Gallery with security audit, versioning, and gallery listing
triggers:
  - publish my app
  - publish to gallery
  - share my app
  - put in gallery
  - make app public
  - submit app
  - distribute app
  - update published app
category: system
tools_needed:
  - read_state
  - Bash
channel_hints:
  - web
  - telegram
examples:
  - publish my calculator app
  - share my todo app with everyone
  - put my budget tracker in the gallery
  - update my published app to version 2
composable_with:
  - build-for-matrix
  - build-html-app
  - build-game
  - app-builder
---

# Publish App to Gallery

Publish a locally-built app to the Matrix OS App Gallery. The gallery runs a 3-layer security audit before listing.

## Steps

### 1. Identify the app

Find the app in `~/apps/{slug}/`. Read its `matrix.json` manifest:

```bash
cat ~/apps/{slug}/matrix.json
```

If `description` is missing, ask the user or generate one from the app code.

### 2. Publish via the gateway API

```bash
curl -X POST http://localhost:4000/api/apps/{slug}/publish \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Short description for gallery listing",
    "longDescription": "Optional detailed description for the detail page",
    "category": "utility",
    "tags": ["tag1", "tag2"],
    "version": "1.0.0",
    "changelog": "Initial release",
    "visibility": "public"
  }'
```

**Required**: `description`, `category`, `version`
**Optional**: `longDescription`, `tags`, `changelog`, `visibility`

### 3. Handle audit results

The response includes `auditStatus` ("passed" or "failed") and `auditFindings`:

**If passed**: App is live. Share the `storeUrl` from the response.

**If failed**: Read `auditFindings` -- each has `layer`, `rule`, `message`, `severity`. Fix the issues and resubmit.

Common findings:
- `path-traversal`: Code contains `../../` -- use paths within app directory only
- `credential-access`: Code uses `process.env` -- use MatrixOS integration APIs instead
- `dynamic-code-execution`: Code uses dynamic code construction -- refactor to avoid

### 4. Update a published app

Same endpoint, bumped `version` and `changelog`:

```bash
curl -X POST http://localhost:4000/api/apps/{slug}/publish \
  -H "Content-Type: application/json" \
  -d '{"description": "...", "version": "1.1.0", "changelog": "Added dark mode", "category": "utility", "visibility": "public"}'
```

Installed users see an update badge automatically.

## Pre-Publish Checklist

- `matrix.json` has `name` and `description`
- App has at least an `index.html`
- No secrets in source (API keys, tokens, passwords)
- Size under 50MB
- No `../../` path traversal in code
- No `process.env` access

## Categories

utility, productivity, games, developer-tools, education, finance, health-fitness, social, music, photo-video, news, entertainment, lifestyle

## Visibility

- `public` -- everyone sees it in the gallery
- `unlisted` -- direct link only
- `organization` -- org members only (pass `orgId`)
