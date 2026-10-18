import type { AppStoreCapabilities, AppStoreManifest, AppStoreScanReport, AppStoreGeneralizationReport, AppStoreListingSummary } from '@matrix-os/contracts/app-store';
export interface StoreActor { userId: string; handle: string }
export interface StoreListingRow {
  id: string; slug: string; publisher_clerk_user_id: string; publisher_handle: string;
  name: string; tagline: string; description: string; category: AppStoreListingSummary['category'];
  status: AppStoreListingSummary['status']; current_version_id: string | null;
  install_count: number; active_install_count: number; rating_sum: number; rating_count: number;
  created_at: string; updated_at: string;
}
export interface StoreVersionRow {
  id: string; listing_id: string; version: string; version_major: number; version_minor: number; version_patch: number;
  submission_key: string; submitted_by_clerk_user_id: string; submission_digest: string;
  status: import('@matrix-os/contracts/app-store').AppStoreSubmissionSummary['status'];
  name: string; tagline: string; description: string; category: StoreListingRow['category']; changelog: string;
  license: import('@matrix-os/contracts/app-store').AppStoreListingDetail['currentVersion'] extends infer T ? NonNullable<T> extends { license: infer L } ? L : never : never;
  capabilities: AppStoreCapabilities; capabilities_digest: string; manifest: AppStoreManifest;
  source_object_key: string; source_sha256: string; source_size: number;
  approval_key_id: string | null; approval_signature: string | null; scan_report: AppStoreScanReport | null;
  generalization_report: AppStoreGeneralizationReport; reviewer_message: string | null;
  decided_by_clerk_user_id: string | null; decided_at: string | null; scanning_started_at: string | null;
  published_at: string | null; created_at: string; updated_at: string;
}
export interface StoreInstallRow { listing_id: string; clerk_user_id: string; version_id: string; first_installed_at: string; last_installed_at: string; uninstalled_at: string | null }
export interface StoreRatingRow { listing_id: string; clerk_user_id: string; stars: number; created_at: string; updated_at: string }
export interface StoreEventRow { id: string; actor_kind: 'reviewer' | 'publisher' | 'system'; actor_clerk_user_id: string | null; action: string; listing_id: string; version_id: string | null; message: string | null; created_at: string }
export interface AppStoreDatabase {
  app_store_listings: StoreListingRow; app_store_versions: StoreVersionRow;
  app_store_installs: StoreInstallRow; app_store_ratings: StoreRatingRow; app_store_moderation_events: StoreEventRow;
}
