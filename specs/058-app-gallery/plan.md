# Implementation Plan: App Gallery

**Branch**: `058-app-gallery` | **Date**: 2026-04-05 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/058-app-gallery/spec.md`

## Summary

Build a multi-user app marketplace for Matrix OS: gallery browsing/search/discovery, publishing with multi-layer security audit, installation with explicit targets (personal/org), versioning with rollback, reviews/ratings, and organization-scoped distribution. The current platform store (SQLite/Drizzle, 3 tables, 8 endpoints) and shell app store (modal-only, hardcoded catalog) are replaced with a Postgres-backed registry and route-based gallery UI.

## Technical Context

**Language/Version**: TypeScript 5.5+ strict, ES modules  
**Primary Dependencies**: Hono (gateway API), Next.js 16 (shell routes), Kysely (Postgres queries), Zod 4 (validation), Zustand (shell state)  
**Storage**: PostgreSQL via Kysely (platform Postgres from 049). Per-user app data already on Postgres via gateway `app-db.ts`.  
**Testing**: Vitest (unit + integration + e2e). 99% coverage target. Integration tests use haiku model.  
**Target Platform**: Linux server (Docker), web browser (shell)  
**Project Type**: Monorepo (packages/gateway, packages/platform, shell, + tests/)  
**Performance Goals**: Gallery search <1s, audit <30s, install <60s end-to-end, 1000+ listings without degradation  
**Constraints**: Platform Postgres must be available (049 dependency). No real money/credits in this version.  
**Scale/Scope**: 1000+ published apps, 10K+ installations, multiple orgs

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Data Belongs to Its Owner | PASS | Listings owned by author. Installations own their instance data. Org data separated from personal data. Uninstall preserves user data optionally. |
| II. AI Is the Kernel | PASS | Gallery is a platform concern, not kernel. Kernel still dispatches all user interactions. |
| III. Headless Core, Multi-Shell | PASS | Gallery API in platform/gateway (headless). Shell renders gallery UI. API usable without shell. |
| IV. Self-Healing | N/A | No self-healing requirements in gallery scope. |
| V. Quality Over Shortcuts | PASS | Route-based UI (not just modal), proper data model, multi-layer audit. |
| VI. App Ecosystem | PASS | This IS the app ecosystem spec. Permissions, trust levels, app store -- all addressed. |
| VII. Multi-Tenancy | PASS | Org support with RBAC (owner/admin/publisher/member). Personal/org boundary enforced. |
| VIII. Defense in Depth | PASS | Multi-layer security audit (manifest + static + sandbox). Installation-time permission grants. Auth on all mutating endpoints. Input validation. |
| IX. TDD | PASS | Tests first for all new modules. Contract tests for API. Integration tests for publish/install flows. |

**No violations. Gate passed.**

## Project Structure

### Documentation (this feature)

```text
specs/058-app-gallery/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
│   ├── store-api.yaml   # Gallery listing/search/detail endpoints
│   ├── publish-api.yaml # Publishing and audit endpoints
│   ├── install-api.yaml # Installation lifecycle endpoints
│   ├── review-api.yaml  # Ratings and reviews endpoints
│   └── org-api.yaml     # Organization management endpoints
└── tasks.md             # Phase 2 output (from /speckit.tasks)
```

### Source Code (repository root)

```text
packages/platform/src/
├── db.ts                    # MODIFY: Postgres connection (from 049)
├── schema.ts                # MODIFY: Re-export new Kysely table types
├── store-api.ts             # REWRITE: Gallery endpoints on Postgres/Kysely
├── app-registry.ts          # REWRITE: Postgres/Kysely queries, new tables
├── gallery/                 # NEW: Gallery domain module
│   ├── listings.ts          # Listing CRUD, search, discovery
│   ├── versions.ts          # Version management, audit status
│   ├── installations.ts     # Installation tracking, update checks
│   ├── reviews.ts           # Ratings, reviews, responses
│   ├── security-audit.ts    # Multi-layer audit engine
│   ├── organizations.ts     # Org CRUD, membership
│   └── migrations.ts        # Kysely migration files for gallery tables
├── main.ts                  # MODIFY: Mount new routes, add auth middleware

packages/gateway/src/
├── app-publish.ts           # MODIFY: Wire to platform registry, add audit trigger
├── app-fork.ts              # MODIFY: Create installation record on fork/install
├── app-manifest.ts          # MODIFY: Add integrations, permissions, visibility fields
├── server.ts                # MODIFY: Add publish/install API routes

shell/src/
├── app/
│   ├── store/
│   │   └── [author]/
│   │       └── [slug]/
│   │           └── page.tsx    # NEW: Store listing detail page
│   ├── a/
│   │   └── [slug]/
│   │       └── page.tsx        # NEW: Personal installed app page
│   └── o/
│       └── [orgSlug]/
│           └── a/
│               └── [slug]/
│                   └── page.tsx # NEW: Org-scoped app page
├── components/app-store/
│   ├── AppStore.tsx             # REWRITE: Route-based gallery, fetch from /api/store
│   ├── AppDetail.tsx            # MODIFY: Add reviews, install targets, permissions
│   ├── InstallDialog.tsx        # NEW: Install target picker + permission grants
│   ├── ReviewSection.tsx        # NEW: Reviews list + submit form
│   ├── PublishDialog.tsx        # NEW: Publish form with metadata + screenshots
│   ├── OrgPicker.tsx            # NEW: Org selection for install/publish
│   └── SecurityBadge.tsx        # NEW: Audit status badge
├── stores/
│   └── app-store.ts             # REWRITE: Fetch from API, remove hardcoded catalog

tests/
├── platform/
│   ├── gallery-listings.test.ts
│   ├── gallery-versions.test.ts
│   ├── gallery-installations.test.ts
│   ├── gallery-reviews.test.ts
│   ├── gallery-security-audit.test.ts
│   ├── gallery-organizations.test.ts
│   └── store-api.test.ts        # REWRITE for new endpoints
├── gateway/
│   ├── app-publish.test.ts      # MODIFY
│   ├── app-fork.test.ts         # MODIFY
│   └── app-manifest.test.ts     # MODIFY
├── shell/
│   ├── store-listing.test.tsx
│   ├── install-dialog.test.tsx
│   ├── review-section.test.tsx
│   └── publish-dialog.test.tsx
└── e2e/
    └── gallery-flow.e2e.test.ts # Full publish -> browse -> install -> review
```

**Structure Decision**: Existing monorepo structure. Gallery domain logic lives in `packages/platform/src/gallery/` as a new module alongside the existing store-api. Shell gains route-based pages alongside the existing modal. Gateway gains publish/install HTTP routes for its existing (but unwired) logic.

## Complexity Tracking

No constitution violations to justify.
