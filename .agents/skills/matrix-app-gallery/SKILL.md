---
name: matrix-app-gallery
description: Work with the Matrix OS App Gallery -- browse, search, install, review, and manage published apps. Use when working on gallery features, store API endpoints, or app marketplace functionality.
---

# Matrix OS App Gallery

The App Gallery is the marketplace for Matrix OS apps. It handles discovery, publishing, installation, reviews, organizations, and app lifecycle.

## Architecture

The gallery spans three packages:

- **platform** (`packages/platform/src/gallery/`): Postgres data layer, store API, org API
- **gateway** (`packages/gateway/src/`): publish, install, update, rollback routes (has filesystem access)
- **shell** (`shell/src/components/app-store/`): gallery UI components

## Key entities

| Entity | Table | Description |
|--------|-------|-------------|
| Listing | `app_listings` | Published app in the gallery (name, slug, author, category, tags, visibility) |
| Version | `app_versions` | Specific release with semver, changelog, audit status |
| Installation | `app_installations` | Record that a user/org installed a listing at a specific version |
| Review | `app_reviews` | 1-5 star rating + optional text, one per user per listing |
| Security Audit | `security_audits` | 3-layer audit results (manifest, static, sandbox) |
| Organization | `organizations` | Named group with roles for private app distribution |
| Org Membership | `org_memberships` | User-to-org relationship with role |

## API endpoints

### Store API (platform, public reads)

```
GET  /api/store/apps                    # Browse with filters
GET  /api/store/apps/search?q=...       # Full-text search (tsvector)
GET  /api/store/apps/:author/:slug      # Listing detail
GET  /api/store/categories              # Category list with counts
GET  /api/store/installations           # User's installed apps (auth required)
GET  /api/store/apps/:id/versions       # Version history
GET  /api/store/apps/:id/reviews        # Reviews with rating distribution
POST /api/store/apps/:id/reviews        # Submit review (must have installed)
POST /api/store/apps/:id/delist         # Delist app (author only)
POST /api/store/apps/:id/flag           # Flag for moderation
```

### Gateway routes (auth required)

```
POST   /api/apps/:slug/publish          # Publish app (runs security audit)
POST   /api/apps/:slug/publish/resubmit # Re-audit after fixes
POST   /api/apps/install                # Install from gallery
DELETE /api/apps/:slug/uninstall        # Uninstall
POST   /api/apps/:slug/update           # Update to latest version
POST   /api/apps/:slug/rollback         # Rollback to previous version
```

### Org API (platform, auth required)

```
POST   /api/store/orgs                  # Create org
GET    /api/store/orgs                  # List user's orgs
GET    /api/store/orgs/:slug            # Org details
POST   /api/store/orgs/:slug/members    # Invite member
GET    /api/store/orgs/:slug/apps       # Org-private apps
```

## URL model

- `/a/{slug}` -- personal installed app
- `/store/{author}/{slug}` -- public listing detail page
- `/o/{orgSlug}/a/{slug}` -- org-scoped app

## Data layer files

```
packages/platform/src/gallery/
  migrations.ts      # Kysely migrations for all 7 tables
  types.ts           # TypeScript interfaces for all tables
  pg.ts              # Postgres connection (createGalleryDb/getGalleryDb)
  listings.ts        # Listing CRUD + tsvector search
  versions.ts        # Version management
  installations.ts   # Installation tracking
  reviews.ts         # Review CRUD + rating aggregation
  security-audit.ts  # 3-layer audit engine
  organizations.ts   # Org + membership CRUD
  org-api.ts         # Hono router for org endpoints
  org-visibility.ts  # Listing visibility filter
  update-detection.ts # Compare installed vs current versions
  index.ts           # Barrel export
```

## Security audit layers

1. **Manifest**: validates permissions against allowed set, checks integration requirements
2. **Static**: pattern scan for path traversal, credential access, dynamic code execution, sandbox escape
3. **Sandbox**: maps permissions to container capabilities, verifies coverage

## Gotchas

- Gateway routes handle file operations (publish reads files, install copies files). Platform routes handle metadata (listings, reviews, orgs).
- The publish flow is cross-package: gateway validates + audits, then creates records on platform Postgres.
- Listings use `tsvector` for search with a GIN index -- don't use LIKE queries.
- `app_listings.slug` is globally unique (not per-author).
- Reviews require an active installation -- check `app_installations` before allowing.
- Org-private apps use visibility filter in listing queries -- never expose org apps to non-members.
- The gallery uses Postgres/Kysely (NOT SQLite/Drizzle). The old SQLite store tables are deprecated.
