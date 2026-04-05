import type { Generated, ColumnType } from 'kysely';

export interface AppListingsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  author_id: string;
  description: string | null;
  long_description: string | null;
  category: Generated<string>;
  tags: Generated<string[]>;
  icon_url: string | null;
  screenshots: Generated<string[]>;
  visibility: Generated<string>;
  org_id: string | null;
  current_version_id: string | null;
  price: Generated<number>;
  installs_count: Generated<number>;
  avg_rating: Generated<string>;
  ratings_count: Generated<number>;
  status: Generated<string>;
  search_vector: string | null;
  manifest: unknown | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AppVersionsTable {
  id: Generated<string>;
  listing_id: string;
  version: string;
  changelog: string | null;
  manifest: unknown;
  bundle_path: string | null;
  audit_status: Generated<string>;
  audit_findings: Generated<unknown>;
  is_current: Generated<boolean>;
  created_at: Generated<Date>;
}

export interface AppInstallationsTable {
  id: Generated<string>;
  listing_id: string;
  version_id: string;
  user_id: string;
  org_id: string | null;
  install_target: string;
  status: Generated<string>;
  data_location: string | null;
  permissions_granted: Generated<string[]>;
  installed_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AppReviewsTable {
  id: Generated<string>;
  listing_id: string;
  reviewer_id: string;
  rating: number;
  body: string | null;
  author_response: string | null;
  author_responded_at: Date | null;
  flagged: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface SecurityAuditsTable {
  id: Generated<string>;
  version_id: string;
  status: Generated<string>;
  manifest_findings: Generated<unknown>;
  static_findings: Generated<unknown>;
  sandbox_findings: Generated<unknown>;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Generated<Date>;
}

export interface OrganizationsTable {
  id: Generated<string>;
  slug: string;
  name: string;
  description: string | null;
  owner_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OrgMembershipsTable {
  id: Generated<string>;
  org_id: string;
  user_id: string;
  role: Generated<string>;
  status: Generated<string>;
  invited_by: string | null;
  joined_at: Date | null;
  created_at: Generated<Date>;
}

export interface GalleryDatabase {
  app_listings: AppListingsTable;
  app_versions: AppVersionsTable;
  app_installations: AppInstallationsTable;
  app_reviews: AppReviewsTable;
  security_audits: SecurityAuditsTable;
  organizations: OrganizationsTable;
  org_memberships: OrgMembershipsTable;
}
