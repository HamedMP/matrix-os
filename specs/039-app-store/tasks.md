# Tasks: App Store + Publishing

**Spec**: spec.md
**Task range**: T1470-T1499
**Parallel**: Partially -- registry (A) is foundation. Publishing (B) and store UI (D) depend on it. Personal websites (E) and fork (C) can run in parallel after A.
**Deps**: 038-app-platform (T1400+), 008B platform service

## User Stories

- **US68**: "I can publish my app to the store by saying 'publish my app'"
- **US69**: "I can browse and install apps from a store inside my OS"
- **US70**: "Anyone can try my app via a public link without signing up"
- **US71**: "My handle gives me a personal website at handle.matrix-os.com"
- **US72**: "I can fork any public app and modify it"
- **US73**: "I can see which apps are popular, new, and well-rated"

---

## Phase A: App Registry (T1470-T1474)

### Tests (TDD)

- [ ] T1470a [US69] Write `tests/platform/app-registry.test.ts`:
  - Create registry entry with valid manifest
  - Reject entry with missing required fields
  - List apps with pagination, filtering by category
  - Search by name and description
  - Increment install count atomically
  - Rating calculation (average of all ratings)

### T1470 [US69] Registry database schema
- [ ] Drizzle schema in `packages/platform/src/schema.ts`
- [ ] apps_registry table (see spec for columns)
- [ ] app_ratings table: `{ app_id, user_id, rating, review, created_at }`
- [ ] app_installs table: `{ app_id, user_id, installed_at }` (for tracking unique installs)
- [ ] Migration + seed with pre-bundled apps from 038

### T1471 [US69] Registry API endpoints
- [ ] `GET /api/store/apps` -- list with pagination, category filter, sort (popular/new/rated)
- [ ] `GET /api/store/apps/:author/:slug` -- single app detail
- [ ] `GET /api/store/apps/search?q=...` -- full-text search
- [ ] `GET /api/store/apps/featured` -- curated list
- [ ] `POST /api/store/apps` -- create/update registry entry (auth required)
- [ ] `POST /api/store/apps/:id/rate` -- submit rating (auth required)
- [ ] `POST /api/store/apps/:id/install` -- increment install count

### T1472 [US69] App file storage
- [ ] Publish uploads app files to S3 (or platform storage)
- [ ] Each app version stored as: `s3://matrix-apps/{author}/{slug}/{version}/`
- [ ] Install downloads from S3 to user's `~/apps/{slug}/`
- [ ] Versioning: new publish creates new version, old versions retained

### T1473 [US73] Categories and tags
- [ ] Predefined categories: game, productivity, utility, social, dev, creative
- [ ] Free-form tags (max 10 per app)
- [ ] Category counts endpoint: `GET /api/store/categories`

---

## Phase B: Publishing Flow (T1475-T1479)

### Tests (TDD)

- [ ] T1475a [US68] Write `tests/gateway/app-publish.test.ts`:
  - publish_app IPC tool creates registry entry
  - Validates matrix.json before publishing
  - Rejects apps without name or description
  - Generates slug from app name
  - Returns public URL on success

### T1475 [US68] publish_app IPC tool
- [ ] New IPC tool in kernel: `publish_app({ appName, description?, tags? })`
- [ ] Reads app directory, validates matrix.json
- [ ] Uploads files to platform storage
- [ ] Creates registry entry via platform API
- [ ] Returns: `{ url, slug, version }`

### T1476 [US68] AI-assisted publishing
- [ ] Skill: `home/agents/skills/publish-app.md`
- [ ] AI generates description from app code if not provided
- [ ] AI suggests category and tags based on app content
- [ ] AI takes screenshots via browser automation (open app, screenshot viewport)
- [ ] Composable with: build-for-matrix

### T1477 [US68] Publish validation
- [ ] matrix.json must have name and description
- [ ] App must start successfully (health check)
- [ ] No secrets in source code (scan for API keys, tokens)
- [ ] Size limit: 50MB per app (configurable)
- [ ] Rate limit: 10 publishes per day per user

---

## Phase C: Fork/Clone (T1480-T1482)

### Tests (TDD)

- [ ] T1480a [US72] Write `tests/gateway/app-fork.test.ts`:
  - fork_app copies files to user's ~/apps/
  - Forked app has forked_from metadata in matrix.json
  - Fork count tracked in registry
  - Can't fork non-public apps

### T1480 [US72] fork_app IPC tool
- [ ] `fork_app({ author, slug })`: downloads app from registry to `~/apps/{slug}/`
- [ ] Adds `forked_from: { author, slug, version }` to local matrix.json
- [ ] Registers as local app in modules.json
- [ ] Increments fork count in registry

### T1481 [US72] Fork UI in store
- [ ] "Fork" button on every public app page
- [ ] Shows fork attribution: "Forked from @author/slug"
- [ ] Fork graph: "42 forks" link showing list of forks

### T1482 [US72] install_app IPC tool
- [ ] `install_app({ author, slug })`: downloads and installs without fork metadata
- [ ] Read-only install (user doesn't get source to modify)
- [ ] Or full install (gets source, can modify but it's an "install" not "fork")
- [ ] User choice: "Install" vs "Fork" presented in UI

---

## Phase D: Store UI (T1485-T1489)

### T1485 [US69] Store shell component
- [ ] `shell/src/components/AppStore.tsx`
- [ ] Tabs: Apps | Games | Skills (skills from 038 Phase F)
- [ ] Grid view with app cards (icon, name, author, rating, installs)
- [ ] Category sidebar filter
- [ ] Search bar with instant results
- [ ] Sort: Popular / New / Top Rated

### T1486 [US69] App detail page
- [ ] Full-page view: screenshots, description, author info, ratings
- [ ] Install / Fork / Rate buttons
- [ ] Version history
- [ ] "More by this author" section

### T1487 [US70] Public app runner
- [ ] Route: `matrix-os.com/run/@author/slug`
- [ ] Renders app in sandbox iframe (no OS chrome)
- [ ] Anonymous: temporary in-memory data, banner "Sign up to save"
- [ ] Logged in: data persisted to viewer's OS
- [ ] "Open in Matrix OS" button for full experience

### T1488 [US70] Store page (public web)
- [ ] Route: `matrix-os.com/store/@author/slug`
- [ ] Public page (no login required to view)
- [ ] Screenshots, description, ratings
- [ ] "Try it" button -> run page
- [ ] "Install" button -> login required
- [ ] SEO-friendly: meta tags, Open Graph, structured data

---

## Phase E: Personal Websites (T1490-T1494)

### T1490 [US71] Subdomain routing
- [ ] Wildcard DNS: `*.matrix-os.com` -> platform service
- [ ] Platform routes `{handle}.matrix-os.com` to user's container
- [ ] Not logged in: serve `~/apps/profile/index.html` (public profile)
- [ ] Logged in as owner: serve full Matrix OS shell
- [ ] Logged in as other user: serve public profile

### T1491 [US71] Default profile app
- [ ] `home/apps/profile/` with matrix.json
- [ ] Template: name, avatar, bio, social links, published apps grid
- [ ] Reads from `~/system/profile.md` and `GET /api/store/apps?author=handle`
- [ ] Clean, modern design (personal website quality)
- [ ] Responsive: looks good on mobile

### T1492 [US71] Profile customization
- [ ] User can edit profile app via chat ("add a dark theme", "show my chess game prominently")
- [ ] AI modifies `~/apps/profile/` files
- [ ] Pre-built themes: minimal, developer, creative, gamer

### T1493 [US71] Custom domain support
- [ ] User can set `custom_domain` in profile settings
- [ ] Platform generates TLS cert via Let's Encrypt
- [ ] CNAME verification: user adds CNAME record pointing to matrix-os.com
- [ ] Cloudflare for All route: `custom-domain -> user container -> profile app`

---

## Checkpoint

1. [ ] `bun run test` passes with all registry and publishing tests
2. [ ] Publish an app via chat: "publish my chess game" -> app appears in store
3. [ ] Browse store: see apps by category, search works, ratings displayed
4. [ ] Public link: `matrix-os.com/run/@hamed/chess` -- play chess without login
5. [ ] Fork: click "Fork" on chess -> copy in my OS, can modify
6. [ ] `hamed.matrix-os.com` shows personal profile page (not logged in)
7. [ ] `hamed.matrix-os.com` shows full OS (logged in as hamed)
8. [ ] Install an app: one click, app appears in dock
9. [ ] Rating: rate an app 5 stars, average updates
