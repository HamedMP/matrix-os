---
name: matrix-app-gallery
description: Reference for the planned Matrix OS App Gallery (spec 058). Use when working on gallery features, store API endpoints, or app marketplace functionality. Not reflective of currently-shipped code -- see "Current state" section.
triggers: []
category: reference
tools_needed:
  - Read
  - Grep
channel_hints:
  - any
examples: []
composable_with:
  - publish-app
  - build-matrix-app
user-invocable: false
---

# Matrix OS App Gallery

**Status**: The full App Gallery described below is specified in `specs/058-app-gallery/spec.md` but has **not** been implemented yet. This document is the target architecture, not the current code. See "Current state" at the bottom for what ships today.

## Planned architecture (058)

The gallery is planned to span three packages:

- **platform** (`packages/platform/src/gallery/`): Postgres data layer, store API, org API
- **gateway** (`packages/gateway/src/`): publish, install, update, rollback routes (has filesystem access)
- **shell** (`shell/src/components/app-store/`): gallery UI components

## Key entities (planned)

| Entity | Table | Description |
|--------|-------|-------------|
| Listing | `app_listings` | Published app in the gallery (name, slug, author, category, tags, visibility) |
| Version | `app_versions` | Specific release with semver, changelog, audit status |
| Installation | `app_installations` | Record that a user/org installed a listing at a specific version |
| Review | `app_reviews` | 1-5 star rating + optional text, one per user per listing |
| Security Audit | `security_audits` | 3-layer audit results (manifest, static, sandbox) |
| Organization | `organizations` | Named group with roles for private app distribution |
| Org Membership | `org_memberships` | User-to-org relationship with role |

## API endpoints (planned)

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

## URL model (planned)

- `/a/{slug}` -- personal installed app
- `/store/{author}/{slug}` -- public listing detail page
- `/o/{orgSlug}/a/{slug}` -- org-scoped app

## Security audit layers (planned)

1. **Manifest**: validates permissions against allowed set, checks integration requirements
2. **Static**: pattern scan for path traversal, credential access, dynamic code execution, sandbox escape
3. **Sandbox**: maps permissions to container capabilities, verifies coverage

## Current state (what ships today)

The pre-058 store is much simpler and already implemented:

- **Platform store API** (`packages/platform/src/store-api.ts`): GET `/apps`, GET `/apps/search`, GET `/apps/:author/:slug`, POST `/apps`, POST `/apps/:id/rate`, POST `/apps/:id/install`, GET `/categories`.
- **Backing tables** (`packages/platform/src/app-registry.ts`): `apps_registry`, `app_ratings`, `app_installs` (SQLite). 058 marks these as "deprecated but not deleted".
- **Publish flow**: the kernel exposes an IPC tool `publish_app` (`packages/kernel/src/ipc-server.ts:804`) which calls `validateForPublish` / `preparePublishPayload` from `packages/gateway/src/app-publish.ts`. The tool currently returns the payload + hypothetical URL; it does not yet POST to the platform store API.
- **Security audit**: `packages/kernel/src/security/audit.ts` exposes `runSecurityAudit(homePath)` returning `SecurityAuditReport { timestamp, findings, summary }`. Findings have `{ checkId, severity: "info"|"warn"|"critical", title, detail, remediation? }`. This is a single-pass audit, not yet a 3-layer pipeline.
- No gallery package, no Postgres gallery tables, no org/membership model.

When you're implementing or touching anything in the gallery area, read `specs/058-app-gallery/` first. That spec is the source of truth for what's planned.
