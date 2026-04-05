---
name: publish-app
description: Publish a Matrix OS app to the App Gallery. Use when asked to publish, share, distribute, or submit an app to the gallery, or when updating a previously published app to a new version.
---

# Publish App to Gallery

Publish a locally-built app to the Matrix OS App Gallery with automated security audit.

## When to use

- User says "publish my app", "share my app", "put my app in the gallery"
- User built an app and wants others to use it
- User wants to update a previously published app to a new version

## Steps

### 1. Verify the app

The app must exist at `~/apps/{slug}/` with a valid `matrix.json`:

```bash
cat ~/apps/{slug}/matrix.json
```

Required manifest fields: `name`, `description`. If `description` is missing, generate one from the app code and update the manifest.

### 2. Publish

```bash
curl -X POST http://localhost:4000/api/apps/{slug}/publish \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Short description for gallery listing",
    "longDescription": "Detailed description for the detail page",
    "category": "utility",
    "tags": ["tag1", "tag2"],
    "version": "1.0.0",
    "changelog": "Initial release",
    "visibility": "public"
  }'
```

**Required**: `description`, `category`, `version`

### 3. Handle the response

**Success** (`auditStatus: "passed"`):
```json
{
  "listingId": "uuid",
  "versionId": "uuid",
  "auditStatus": "passed",
  "storeUrl": "/store/{author}/{slug}"
}
```

**Audit failed** (`auditStatus: "failed"`): Read `auditFindings` for specific issues per layer. Fix and resubmit.

### 4. Update a published app

Same endpoint, bump the version:

```bash
curl -X POST http://localhost:4000/api/apps/{slug}/publish \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Updated description",
    "version": "1.1.0",
    "changelog": "Added dark mode, fixed mobile layout",
    "category": "utility",
    "visibility": "public"
  }'
```

## Security audit layers

Every publish runs these checks automatically:

1. **Manifest**: validates permissions, checks integration requirements
2. **Static analysis**: scans for path traversal (`../../`), `process.env` access, dynamic code construction, `child_process`, unauthorized fetch targets
3. **Sandbox policy**: verifies declared permissions map to enforceable container capabilities

## Categories

utility, productivity, games, developer-tools, education, finance, health-fitness, social, music, photo-video, news, entertainment, lifestyle

## Visibility options

- `public` -- everyone sees it in the gallery
- `unlisted` -- direct link only, not in search results
- `organization` -- org members only (pass `orgId` in the request)

## Gotchas

- The `slug` in the URL must match the app's directory name in `~/apps/`
- First publish creates a new listing; subsequent publishes with the same slug create new versions
- Failed audits block publication -- the app does NOT appear in the gallery until it passes
- The `version` field must follow semver (e.g., 1.0.0, 1.2.3) and must be higher than the previous version
