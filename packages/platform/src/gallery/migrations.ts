import type { Kysely } from 'kysely';
import { sql } from 'kysely';

export async function runGalleryMigrations(db: Kysely<any>): Promise<void> {
  await createOrganizations(db);
  await createAppListings(db);
  await createAppVersions(db);
  await createAppInstallations(db);
  await createAppReviews(db);
  await createSecurityAudits(db);
  await createOrgMemberships(db);
  await createSearchVectorTrigger(db);
}

async function createOrganizations(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('organizations')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('owner_id', 'uuid', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_orgs_slug')
    .ifNotExists()
    .unique()
    .on('organizations')
    .column('slug')
    .execute();

  await db.schema
    .createIndex('idx_orgs_owner')
    .ifNotExists()
    .on('organizations')
    .column('owner_id')
    .execute();
}

async function createAppListings(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_listings')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('slug', 'text', (col) => col.notNull().unique())
    .addColumn('name', 'text', (col) => col.notNull())
    .addColumn('author_id', 'uuid', (col) => col.notNull())
    .addColumn('description', 'text')
    .addColumn('long_description', 'text')
    .addColumn('category', 'text', (col) => col.notNull().defaultTo('utility'))
    .addColumn('tags', sql`text[]`, (col) => col.defaultTo(sql`'{}'`))
    .addColumn('icon_url', 'text')
    .addColumn('screenshots', sql`text[]`, (col) => col.defaultTo(sql`'{}'`))
    .addColumn('visibility', 'text', (col) => col.notNull().defaultTo('public'))
    .addColumn('org_id', 'uuid', (col) => col.references('organizations.id'))
    .addColumn('current_version_id', 'uuid')
    .addColumn('price', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('installs_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('avg_rating', sql`numeric(2,1)`, (col) => col.notNull().defaultTo(0.0))
    .addColumn('ratings_count', 'integer', (col) => col.notNull().defaultTo(0))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('search_vector', sql`tsvector`)
    .addColumn('manifest', 'jsonb')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_listings_slug')
    .ifNotExists()
    .unique()
    .on('app_listings')
    .column('slug')
    .execute();

  await db.schema
    .createIndex('idx_listings_author')
    .ifNotExists()
    .on('app_listings')
    .column('author_id')
    .execute();

  await db.schema
    .createIndex('idx_listings_category')
    .ifNotExists()
    .on('app_listings')
    .column('category')
    .execute();

  await db.schema
    .createIndex('idx_listings_visibility')
    .ifNotExists()
    .on('app_listings')
    .column('visibility')
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_listings_org ON app_listings (org_id) WHERE org_id IS NOT NULL`.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_listings_search ON app_listings USING GIN (search_vector)`.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_listings_popular ON app_listings (installs_count DESC)`.execute(db);

  await sql`CREATE INDEX IF NOT EXISTS idx_listings_rated ON app_listings (avg_rating DESC)`.execute(db);
}

async function createAppVersions(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_versions')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('listing_id', 'uuid', (col) => col.notNull().references('app_listings.id'))
    .addColumn('version', 'text', (col) => col.notNull())
    .addColumn('changelog', 'text')
    .addColumn('manifest', 'jsonb', (col) => col.notNull())
    .addColumn('bundle_path', 'text')
    .addColumn('audit_status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('audit_findings', 'jsonb', (col) => col.defaultTo(sql`'[]'`))
    .addColumn('is_current', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_versions_listing')
    .ifNotExists()
    .on('app_versions')
    .column('listing_id')
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_versions_listing_current ON app_versions (listing_id) WHERE is_current = true`.execute(db);

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_listing_version ON app_versions (listing_id, version)`.execute(db);

  // Add FK from app_listings.current_version_id to app_versions.id (deferred -- table already exists)
  await sql`
    DO $$ BEGIN
      ALTER TABLE app_listings
        ADD CONSTRAINT fk_listings_current_version
        FOREIGN KEY (current_version_id) REFERENCES app_versions(id);
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `.execute(db);
}

async function createAppInstallations(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_installations')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('listing_id', 'uuid', (col) => col.notNull().references('app_listings.id'))
    .addColumn('version_id', 'uuid', (col) => col.notNull().references('app_versions.id'))
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('org_id', 'uuid', (col) => col.references('organizations.id'))
    .addColumn('install_target', 'text', (col) => col.notNull())
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('active'))
    .addColumn('data_location', 'text')
    .addColumn('permissions_granted', sql`text[]`, (col) => col.defaultTo(sql`'{}'`))
    .addColumn('installed_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_installations_user')
    .ifNotExists()
    .on('app_installations')
    .column('user_id')
    .execute();

  await db.schema
    .createIndex('idx_installations_listing')
    .ifNotExists()
    .on('app_installations')
    .column('listing_id')
    .execute();

  await sql`CREATE INDEX IF NOT EXISTS idx_installations_org ON app_installations (org_id) WHERE org_id IS NOT NULL`.execute(db);

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_installations_unique ON app_installations (listing_id, user_id, COALESCE(org_id, '00000000-0000-0000-0000-000000000000'))`.execute(db);
}

async function createAppReviews(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('app_reviews')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('listing_id', 'uuid', (col) => col.notNull().references('app_listings.id'))
    .addColumn('reviewer_id', 'uuid', (col) => col.notNull())
    .addColumn('rating', 'int2', (col) => col.notNull().check(sql`rating >= 1 AND rating <= 5`))
    .addColumn('body', 'text')
    .addColumn('author_response', 'text')
    .addColumn('author_responded_at', 'timestamptz')
    .addColumn('flagged', 'boolean', (col) => col.notNull().defaultTo(false))
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .addColumn('updated_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_reviews_listing')
    .ifNotExists()
    .on('app_reviews')
    .column('listing_id')
    .execute();

  await db.schema
    .createIndex('idx_reviews_reviewer')
    .ifNotExists()
    .on('app_reviews')
    .column('reviewer_id')
    .execute();

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_unique ON app_reviews (listing_id, reviewer_id)`.execute(db);
}

async function createSecurityAudits(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('security_audits')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('version_id', 'uuid', (col) => col.notNull().references('app_versions.id'))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('manifest_findings', 'jsonb', (col) => col.defaultTo(sql`'[]'`))
    .addColumn('static_findings', 'jsonb', (col) => col.defaultTo(sql`'[]'`))
    .addColumn('sandbox_findings', 'jsonb', (col) => col.defaultTo(sql`'[]'`))
    .addColumn('started_at', 'timestamptz')
    .addColumn('completed_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_audits_version')
    .ifNotExists()
    .on('security_audits')
    .column('version_id')
    .execute();

  await db.schema
    .createIndex('idx_audits_status')
    .ifNotExists()
    .on('security_audits')
    .column('status')
    .execute();
}

async function createOrgMemberships(db: Kysely<any>): Promise<void> {
  await db.schema
    .createTable('org_memberships')
    .ifNotExists()
    .addColumn('id', 'uuid', (col) => col.primaryKey().defaultTo(sql`gen_random_uuid()`))
    .addColumn('org_id', 'uuid', (col) => col.notNull().references('organizations.id'))
    .addColumn('user_id', 'uuid', (col) => col.notNull())
    .addColumn('role', 'text', (col) => col.notNull().defaultTo('member'))
    .addColumn('status', 'text', (col) => col.notNull().defaultTo('pending'))
    .addColumn('invited_by', 'uuid')
    .addColumn('joined_at', 'timestamptz')
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`now()`))
    .execute();

  await db.schema
    .createIndex('idx_memberships_org')
    .ifNotExists()
    .on('org_memberships')
    .column('org_id')
    .execute();

  await db.schema
    .createIndex('idx_memberships_user')
    .ifNotExists()
    .on('org_memberships')
    .column('user_id')
    .execute();

  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_unique ON org_memberships (org_id, user_id)`.execute(db);
}

async function createSearchVectorTrigger(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION app_listings_search_vector_update() RETURNS trigger AS $$
    BEGIN
      NEW.search_vector := to_tsvector('english',
        NEW.name || ' ' || COALESCE(NEW.description, '') || ' ' || array_to_string(NEW.tags, ' ')
      );
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `.execute(db);

  await sql`
    DO $$ BEGIN
      CREATE TRIGGER trg_app_listings_search_vector
        BEFORE INSERT OR UPDATE OF name, description, tags
        ON app_listings
        FOR EACH ROW
        EXECUTE FUNCTION app_listings_search_vector_update();
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$
  `.execute(db);
}
