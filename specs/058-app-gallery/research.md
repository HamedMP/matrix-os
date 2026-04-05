# Research: App Gallery

**Phase 0 output for 058-app-gallery**

## R1: Platform DB Migration (SQLite -> Postgres)

**Decision**: Gallery tables are built directly on Postgres via Kysely. The existing SQLite tables (`apps_registry`, `app_ratings`, `app_installs`) are deprecated and replaced.

**Rationale**: 049 owns the platform Postgres migration. 058 creates its own tables (`app_listings`, `app_versions`, `app_installations`, `app_reviews`, `security_audits`, `organizations`, `org_memberships`) on the same Postgres instance. This avoids dual-database complexity and gives us real full-text search, JSONB columns, proper foreign keys, and transactional integrity.

**Alternatives considered**:
- Keep SQLite, add gallery on top: rejected because SQLite full-text search (LIKE with wildcards) doesn't scale to 1000+ listings and lacks JSONB, array types, and proper FK enforcement.
- Separate Postgres instance for gallery: rejected as unnecessary -- one platform Postgres is simpler.

**Migration path**: 
1. 049 sets up platform Postgres + Kysely + migration tooling + `users` table
2. 058 adds gallery tables via Kysely migrations
3. Existing `apps_registry` data can be migrated via a one-time script (copy to `app_listings`)
4. Old SQLite tables are left in place until fully deprecated

## R2: Full-Text Search on Postgres

**Decision**: Use PostgreSQL `tsvector` + `tsquery` for gallery search, with GIN index on a generated `search_vector` column combining name, description, and tags.

**Rationale**: Postgres native full-text search is fast (sub-100ms on 10K+ rows with GIN index), requires no external service, supports ranking, stemming, and prefix matching. The current SQLite LIKE-based search (`%query%`) has no index support and degrades linearly.

**Alternatives considered**:
- Elasticsearch/Meilisearch: rejected for MVP -- adds infrastructure complexity. Can be added later if search quality needs improvement.
- `ILIKE` on Postgres: rejected because it doesn't support ranking or stemming.
- `pg_trgm` trigram extension: viable alternative for fuzzy matching, but `tsvector` is better for keyword-based app search.

## R3: Security Audit Implementation

**Decision**: Three-layer automated audit, all running synchronously at publish/update time. No human review queue for v1.

**Rationale**: Apps are built in-platform by the AI agent, not uploaded as opaque binaries. The threat model is: prevent apps from escaping their sandbox, accessing other users' data, or declaring excessive permissions. Static analysis is sufficient for v1 because app code is inspectable and the container sandbox provides runtime enforcement.

**Layer 1 - Manifest audit**:
- Validate declared permissions against allowed set
- Flag mismatches (e.g., "network" permission on a calculator)
- Check `integrations.required` against 049 service registry

**Layer 2 - Static code scan**:
- Pattern-based scan for: `../../` path traversal, `process.env` access, dynamic code execution, dynamic imports of external URLs, fetch to non-allowed domains, filesystem calls outside sandbox, `child_process` usage
- Configurable rule set (add patterns without code changes)

**Layer 3 - Sandbox policy verification**:
- Map declared permissions to container capabilities
- Verify no undeclared capabilities are needed (based on static analysis findings)
- Generate sandbox policy config for the app

**Alternatives considered**:
- Human review queue: rejected for v1 -- too slow for the developer experience. Add later for high-trust apps.
- Runtime behavior monitoring: deferred -- container already sandboxes apps. Runtime monitoring is additive.
- Signed bundles with hash verification: deferred -- apps are built in-platform, not uploaded. Add when external developers are supported.

## R4: App URL Routing in Next.js

**Decision**: Add route-based pages alongside the existing modal store. The modal becomes a lightweight browse/search interface; detail pages are full routes.

**Rationale**: The current modal (`AppStore.tsx`) works for quick discovery, but SEO, deep linking, browser history, and shareable URLs require real routes. Next.js App Router supports dynamic segments natively.

**Routes**:
- `/store/[author]/[slug]/page.tsx` -- public listing detail (SSR for SEO)
- `/a/[slug]/page.tsx` -- personal installed app (client-side, authenticated)
- `/o/[orgSlug]/a/[slug]/page.tsx` -- org-scoped app (client-side, authenticated)

**Modal integration**: The store modal links to `/store/{author}/{slug}` for detail views. Install from either modal or detail page.

**Alternatives considered**:
- Keep everything in modal: rejected because store listing URLs must be publicly accessible (FR-024) and SEO-friendly.
- Full SPA routing (no SSR): rejected because store listings benefit from SSR for SEO and social sharing (Open Graph).

## R5: Organization Model

**Decision**: 058 owns organizations as a gallery-scoped feature. Lightweight model: no billing, no seats limits, no nested orgs.

**Rationale**: Orgs exist to scope app visibility and install targets. The simplest model is: create org, invite members, assign roles, publish org-private apps. This can be extracted to a platform-level spec later if orgs need to span beyond the gallery.

**Roles**:
- `owner` -- created the org, full control, can delete org
- `admin` -- manage members, manage org apps, cannot delete org
- `publisher` -- can publish org-private apps
- `member` -- can browse and install org apps

**Invitations**: By handle (Matrix handle lookup) or email (Clerk email lookup). Invitation creates a pending membership that the invitee accepts/declines.

**Alternatives considered**:
- Clerk Organizations: Clerk has built-in org support, but coupling gallery orgs to Clerk adds vendor lock-in and limits flexibility.
- Platform-level orgs from day one: rejected -- too broad for 058 scope. Gallery orgs are sufficient for private distribution.

## R6: Install Flow Architecture

**Decision**: Install is a multi-step operation: validate -> permission grant -> copy files -> create installation record -> provision storage -> activate.

**Rationale**: The current fork/install (`app-fork.ts`) is a simple directory copy with no record-keeping. The gallery needs Installation records for update tracking, uninstall, and data management.

**Flow**:
1. User clicks Install on listing detail page
2. Shell shows InstallDialog with:
   - Install target picker (personal / org dropdown)
   - Permission summary (from manifest)
   - Required integrations (with connect prompts)
3. User approves -> POST to gateway
4. Gateway validates: user auth, listing exists, not already installed, org membership (if org target)
5. Gateway copies app files to user's `~/apps/{slug}/`
6. Platform creates `app_installations` record
7. Gateway provisions app database schema (existing `app-db.ts` flow)
8. If required integrations not connected: status = "setup-required"
9. Else: status = "active"
10. Shell receives success -> opens app at `/a/{slug}`

**Alternatives considered**:
- Keep simple directory copy: rejected because no installation tracking means no update notifications, no data management on uninstall.
- Download from artifact storage: deferred -- apps are currently filesystem-based. Artifact storage is a future optimization.

## R7: Existing Code Reuse vs. Rewrite

**Decision**: Rewrite `store-api.ts` and `app-registry.ts` for Postgres/Kysely. Modify (not rewrite) gateway files (`app-publish.ts`, `app-fork.ts`, `app-manifest.ts`). Rewrite shell store to fetch from API.

**Rationale**: The platform store code is tightly coupled to SQLite/Drizzle. Rewriting for Postgres/Kysely is cleaner than adapting. The gateway code (manifest, fork, publish) is storage-agnostic and can be extended. The shell store needs to drop its hardcoded catalog and fetch from the API.

**Reuse inventory**:
- `app-manifest.ts`: KEEP + extend (add integrations, permissions, visibility fields)
- `app-publish.ts`: KEEP + extend (add audit trigger, wire to platform registry)
- `app-fork.ts`: KEEP + extend (create installation record)
- `app-manager.ts`: KEEP as-is (lifecycle management unchanged)
- `app-ops.ts`: KEEP as-is (rename/delete)
- `app-db.ts`: KEEP as-is (per-app database provisioning)
- `store-api.ts`: REWRITE (new Postgres endpoints)
- `app-registry.ts`: REWRITE (Kysely queries on new tables)
- `shell/stores/app-store.ts`: REWRITE (API-driven, remove hardcoded catalog)
- `shell/components/app-store/`: MODIFY existing + add new components

**Alternatives considered**:
- Adapter pattern (abstract DB behind interface): rejected -- unnecessary indirection for a one-time migration from SQLite to Postgres.
