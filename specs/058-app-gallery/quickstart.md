# Quickstart: App Gallery

**How to verify the gallery works end-to-end after implementation.**

## Prerequisites

1. Platform Postgres running (from 049) with `users` table populated
2. Gallery migrations applied (creates all 7 tables)
3. Gateway and shell running (`bun run dev`)

## Smoke Test: Publish -> Browse -> Install -> Review

### 1. Publish an app

```bash
# From a user's container, publish the built-in calculator app
curl -X POST http://localhost:4000/api/apps/calculator/publish \
  -H "Content-Type: application/json" \
  -d '{
    "description": "Scientific calculator with history",
    "category": "utility",
    "tags": ["math", "calculator", "science"],
    "visibility": "public",
    "version": "1.0.0"
  }'

# Expected: 201 with listingId, versionId, auditStatus: "passed", storeUrl
```

### 2. Browse the gallery

```bash
# List all public apps
curl http://localhost:8080/api/store/apps

# Search for calculator
curl "http://localhost:8080/api/store/apps/search?q=calculator"

# Get listing detail
curl http://localhost:8080/api/store/apps/{author}/{slug}
```

### 3. Install the app (as a different user)

```bash
curl -X POST http://localhost:4000/api/apps/install \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {other_user_token}" \
  -d '{
    "listingId": "{listing_id}",
    "target": "personal",
    "approvedPermissions": []
  }'

# Expected: 201 with installationId, status: "active", appUrl: "/a/calculator"
```

### 4. Leave a review

```bash
curl -X POST http://localhost:8080/api/store/apps/{listing_id}/reviews \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {other_user_token}" \
  -d '{
    "rating": 5,
    "body": "Great calculator!"
  }'

# Expected: 201 with reviewId, updated avgRating
```

### 5. Verify in shell

1. Open browser to `http://localhost:3000`
2. Open App Store (dock button)
3. See published calculator in gallery
4. Navigate to `/store/{author}/calculator` -- see detail page with review
5. Install from detail page -> app opens at `/a/calculator`

## Key URLs

| URL | What it shows |
|-----|---------------|
| `/store/{author}/{slug}` | Public listing detail page |
| `/a/{slug}` | Personal installed app |
| `/o/{orgSlug}/a/{slug}` | Org-scoped installed app |

## Test Commands

```bash
# Unit tests
bun run test -- --filter gallery

# Integration tests (requires Postgres)
bun run test:integration -- --filter gallery

# E2E test (requires running services)
bun run test:e2e -- --filter gallery-flow
```
