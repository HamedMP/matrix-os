# Spec 039: App Store + Publishing

**Goal**: App registry where users browse, install, publish, and fork apps. Public app URLs let anyone try an app without signing up (but data requires an account). Personal websites at `user.matrix-os.com`. Shareable app links as the primary viral mechanic.

**Supersedes**: 024-app-ecosystem Part B (T763-T766). Builds on 038-app-platform for runtime.

## Problem

1. No way to discover apps other users have built
2. No publishing flow -- apps are trapped in the creator's OS
3. No public URLs for apps -- can't share outside Matrix OS
4. No personal website / public profile page
5. No fork/clone mechanic for apps -- can't remix other people's work
6. No install count, ratings, or social proof
7. App data model unclear for public apps (where does viewer data live?)

## Solution

### A: App Registry

Central catalog of all published apps, stored in the platform database (Drizzle/SQLite on platform service):

```
apps_registry table:
  id           TEXT PRIMARY KEY
  name         TEXT NOT NULL
  slug         TEXT UNIQUE          -- URL-safe name (e.g., "snake-game")
  author_id    TEXT NOT NULL         -- publisher's handle
  description  TEXT
  category     TEXT                  -- game, productivity, utility, social, dev, creative
  tags         TEXT                  -- JSON array of tags
  version      TEXT DEFAULT '1.0.0'
  source_url   TEXT                  -- git URL or platform storage path
  manifest     TEXT                  -- full matrix.json as JSON string
  screenshots  TEXT                  -- JSON array of image URLs
  installs     INTEGER DEFAULT 0
  rating       REAL DEFAULT 0
  ratings_count INTEGER DEFAULT 0
  is_public    BOOLEAN DEFAULT false -- visible in store
  created_at   TEXT
  updated_at   TEXT
```

### B: Publishing Flow

User says "publish my app" or clicks "Publish" in app settings:

1. AI validates app (matrix.json present, app runs, no obvious errors)
2. AI generates description, screenshots (via browser automation), tags
3. Creates registry entry via platform API
4. App files uploaded to platform storage (S3 or git repo)
5. Returns public URL: `matrix-os.com/store/{author}/{slug}`
6. App appears in store after auto-validation (no manual review for sandboxed apps)

For apps requesting elevated permissions (OS access, network, database), a basic automated review checks for known patterns. Manual review for system-level apps.

### C: Public App URLs

Any published app gets a public URL:

- **Store page**: `matrix-os.com/store/@hamed/chess` -- description, screenshots, install button
- **Run page**: `matrix-os.com/run/@hamed/chess` -- runs the app immediately in a sandbox

**Run page behavior:**
- Anonymous visitor: app runs in a temporary sandbox. No data persistence. Banner: "Sign up to save your progress"
- Logged-in user without app installed: app runs, data saved to viewer's OS (`~/data/{app}/`)
- Logged-in user with app installed: redirects to their own instance

Data always lives on the VIEWER's OS, never the publisher's. The publisher provides code; the viewer provides data storage.

### D: Personal Websites

Every user gets `{handle}.matrix-os.com`:

- **Not logged in**: shows public profile page (bio, avatar, published apps, recent activity)
- **Logged in as owner**: full Matrix OS experience (desktop, apps, chat)
- **Custom domain**: users can point their own domain (CNAME to matrix-os.com)

Profile page is itself a Matrix OS app (`~/apps/profile/`) that the user can customize:
- Default template: clean personal page with name, bio, links, published apps
- User can modify via chat ("make my profile page dark", "add my GitHub link")
- AI rebuilds the profile app based on instructions

### E: Clone/Fork

"Fork this app" = one click to get your own editable copy:

1. User clicks "Fork" on any public app
2. App files copied to `~/apps/{slug}/` on their OS
3. Registered as a local app with `forked_from` metadata
4. User can modify freely (it's just files)
5. Can re-publish their fork (attribution to original author)

Fork graph tracked in registry: "Forked from @hamed/chess" shown on store page. Creates network effects -- popular apps get many forks.

### F: Discovery + Social Proof

- **Featured**: curated apps on store homepage (platform admin picks)
- **Popular**: sorted by installs in last 7 days
- **New**: recently published
- **Categories**: games, productivity, utility, social, dev, creative
- **Search**: full-text search on name, description, tags
- **Ratings**: 1-5 stars, users can rate after installing
- **Collections**: curated lists ("Best Games", "Developer Tools")

### G: Monetization Hooks (Future)

Not implemented now, but schema supports:
- `price` field in registry (free/paid/freemium)
- Revenue split (platform takes 15%, creator gets 85%)
- Subscription apps (recurring billing)
- "Tip the creator" button

## Non-Goals

- Payment processing (future spec)
- App review queue (automated validation only for now)
- App analytics dashboard for publishers (future)
- Private app sharing (invite-only apps -- future)

## Dependencies

- 038-app-platform: app runtime, matrix.json manifest
- 008B: platform service (multi-tenant, Clerk auth, Drizzle)
- 040-storage: S3 for app file storage

## Success Metrics

- User publishes an app in under 30 seconds via chat
- Public app link works for anonymous visitors (try before signup)
- "Fork this app" works in one click
- `{handle}.matrix-os.com` shows a personal page for every user
- Store has 20+ apps within first month (pre-seeded + community)
