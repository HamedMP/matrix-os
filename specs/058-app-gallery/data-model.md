# Data Model: App Gallery

**Phase 1 output for 058-app-gallery**

All tables live in the platform Postgres instance (from 049). Foreign keys reference `049.users.id`.

## Tables

### app_listings

The gallery's unit of discovery. One row per published app.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| slug | text | UNIQUE, NOT NULL | Globally unique, URL-safe |
| name | text | NOT NULL | Display name |
| author_id | uuid | FK -> users.id, NOT NULL | Publisher |
| description | text | | Short description for cards |
| long_description | text | | Full description for detail page |
| category | text | NOT NULL, default 'utility' | |
| tags | text[] | default '{}' | Array of tags |
| icon_url | text | | Path to generated icon |
| screenshots | text[] | default '{}' | Array of screenshot URLs |
| visibility | text | NOT NULL, default 'public' | 'public', 'organization', 'unlisted' |
| org_id | uuid | FK -> organizations.id, nullable | Set when visibility = 'organization' |
| current_version_id | uuid | FK -> app_versions.id, nullable | Points to active version |
| price | integer | NOT NULL, default 0 | Credits (0 = free). Forward compat. |
| installs_count | integer | NOT NULL, default 0 | Denormalized |
| avg_rating | numeric(2,1) | NOT NULL, default 0.0 | Denormalized |
| ratings_count | integer | NOT NULL, default 0 | Denormalized |
| status | text | NOT NULL, default 'active' | 'active', 'delisted', 'suspended' |
| search_vector | tsvector | | Generated from name + description + tags |
| manifest | jsonb | | Snapshot of matrix.json at publish time |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_listings_slug` UNIQUE on (slug)
- `idx_listings_author` on (author_id)
- `idx_listings_category` on (category)
- `idx_listings_visibility` on (visibility)
- `idx_listings_org` on (org_id) WHERE org_id IS NOT NULL
- `idx_listings_search` GIN on (search_vector)
- `idx_listings_popular` on (installs_count DESC)
- `idx_listings_rated` on (avg_rating DESC)

**Trigger**: Update `search_vector` on INSERT/UPDATE of name, description, tags using `to_tsvector('english', name || ' ' || coalesce(description, '') || ' ' || array_to_string(tags, ' '))`.

---

### app_versions

Immutable release records. One listing has many versions.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| listing_id | uuid | FK -> app_listings.id, NOT NULL | |
| version | text | NOT NULL | Semver string (e.g., "1.2.0") |
| changelog | text | | What changed in this version |
| manifest | jsonb | NOT NULL | Full matrix.json at this version |
| bundle_path | text | | Path to archived app files |
| audit_status | text | NOT NULL, default 'pending' | 'pending', 'passed', 'failed' |
| audit_findings | jsonb | default '[]' | Array of finding objects |
| is_current | boolean | NOT NULL, default false | Only one per listing |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_versions_listing` on (listing_id)
- `idx_versions_listing_current` on (listing_id) WHERE is_current = true
- UNIQUE on (listing_id, version)

---

### app_installations

Tracks who installed what. The critical entity for updates, uninstall, and data management.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| listing_id | uuid | FK -> app_listings.id, NOT NULL | |
| version_id | uuid | FK -> app_versions.id, NOT NULL | Currently installed version |
| user_id | uuid | FK -> users.id, NOT NULL | Who installed it |
| org_id | uuid | FK -> organizations.id, nullable | Set for org installs |
| install_target | text | NOT NULL | 'personal' or 'organization' |
| status | text | NOT NULL, default 'active' | 'active', 'setup-required', 'suspended', 'update-available' |
| data_location | text | | Path or schema reference for app data |
| permissions_granted | text[] | default '{}' | Permissions user approved at install |
| installed_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_installations_user` on (user_id)
- `idx_installations_listing` on (listing_id)
- `idx_installations_org` on (org_id) WHERE org_id IS NOT NULL
- UNIQUE on (listing_id, user_id, org_id) -- one install per user per listing per org context

---

### app_reviews

One review per user per listing.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| listing_id | uuid | FK -> app_listings.id, NOT NULL | |
| reviewer_id | uuid | FK -> users.id, NOT NULL | |
| rating | smallint | NOT NULL, CHECK (1-5) | |
| body | text | | Optional text review |
| author_response | text | | Listing author's reply |
| author_responded_at | timestamptz | | |
| flagged | boolean | NOT NULL, default false | Flagged for moderation |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_reviews_listing` on (listing_id)
- `idx_reviews_reviewer` on (reviewer_id)
- UNIQUE on (listing_id, reviewer_id) -- one review per user per listing

---

### security_audits

Per-version audit results.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| version_id | uuid | FK -> app_versions.id, NOT NULL | |
| status | text | NOT NULL, default 'pending' | 'pending', 'passed', 'failed' |
| manifest_findings | jsonb | default '[]' | Layer 1 results |
| static_findings | jsonb | default '[]' | Layer 2 results |
| sandbox_findings | jsonb | default '[]' | Layer 3 results |
| started_at | timestamptz | | |
| completed_at | timestamptz | | |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_audits_version` on (version_id)
- `idx_audits_status` on (status)

---

### organizations

Gallery-scoped org model.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| slug | text | UNIQUE, NOT NULL | URL-safe org identifier |
| name | text | NOT NULL | Display name |
| description | text | | |
| owner_id | uuid | FK -> users.id, NOT NULL | Creator |
| created_at | timestamptz | NOT NULL, default now() | |
| updated_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_orgs_slug` UNIQUE on (slug)
- `idx_orgs_owner` on (owner_id)

---

### org_memberships

User-to-org relationships.

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, default gen_random_uuid() | |
| org_id | uuid | FK -> organizations.id, NOT NULL | |
| user_id | uuid | FK -> users.id, NOT NULL | |
| role | text | NOT NULL, default 'member' | 'owner', 'admin', 'publisher', 'member' |
| status | text | NOT NULL, default 'pending' | 'pending', 'active', 'removed' |
| invited_by | uuid | FK -> users.id | Who invited this member |
| joined_at | timestamptz | | Set when status -> 'active' |
| created_at | timestamptz | NOT NULL, default now() | |

**Indexes**:
- `idx_memberships_org` on (org_id)
- `idx_memberships_user` on (user_id)
- UNIQUE on (org_id, user_id)

## State Transitions

### Listing Status
```
active -> delisted    (author removes from gallery, installations persist)
active -> suspended   (platform moderation action)
delisted -> active    (author re-lists)
suspended -> active   (moderation resolved)
```

### Version Audit Status
```
pending -> passed     (all 3 audit layers pass)
pending -> failed     (any audit layer fails)
failed -> pending     (resubmission triggers new audit)
```

### Installation Status
```
active -> update-available  (new version published)
active -> suspended         (listing suspended)
setup-required -> active    (required integrations connected)
update-available -> active  (user updates to new version)
```

### Org Membership Status
```
pending -> active     (invitee accepts)
pending -> removed    (invitation declined or revoked)
active -> removed     (admin removes member or member leaves)
```

## Manifest v2 Extensions

Fields added to `matrix.json` (AppManifest schema) for gallery support:

```typescript
{
  // Existing fields preserved...
  
  // NEW: Integration declarations
  integrations?: {
    required?: string[]   // e.g., ["gmail.read", "calendar.write"]
    optional?: string[]   // e.g., ["slack.send"]
  }
  
  // NEW: Gallery metadata (set during publish, not by developer)
  distribution?: {
    visibility: "public" | "organization" | "unlisted"
    org_id?: string
    published_at?: string   // ISO timestamp
    listing_id?: string     // Reference back to gallery listing
  }
  
  // EXISTING but formalized:
  permissions: string[]     // Already in schema, now validated by audit
  
  // EXISTING metadata from fork/install:
  forked_from?: { author: string; slug: string; version: string }
  installed_from?: { slug: string; installedAt: string; listing_id?: string; version_id?: string }
}
```
