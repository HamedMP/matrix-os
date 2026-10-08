/**
 * Connector sources (Linear, Google Drive, Google Calendar, Slack bridge): handler dependencies, the Slack capture
 * reader seam and the bounds every adapter shares. Types and constants only.
 */
import type { Kysely } from "kysely";
import type { BrainIntegrationCaller, BrainIntegrationService } from "../../contracts.js";
import type { BrainDatabase } from "../../types.js";

export type BrainConnectorKind = "linear" | "google_drive" | "google_calendar" | "slack_bridge";
export const BRAIN_CONNECTOR_KINDS: readonly BrainConnectorKind[] = [
  "linear", "google_drive", "google_calendar", "slack_bridge",
];

export const BRAIN_CONNECTOR_LIMITS = {
  /** Per provider call when the handler is given no providerTimeoutMs. */
  providerTimeoutMs: 10_000,
  /** First Linear pass reads this far back (history_window_limited). */
  linearHistoryDays: 365,
  linearPageSize: 100,
  /** Drive listing per run: files, folders visited (configured plus subfolders), depth below a configured folder. */
  driveFilesMax: 2_000, driveFoldersMax: 30, driveDepthMax: 2, drivePageSize: 1_000,
  /** Docs exported per page (each export is one provider call). */
  driveExportsPerPage: 10,
  /** Calendar events per listing, and documents kept per calendar source (oldest history deleted past it). */
  calendarEventsMax: 2_000, calendarPageSize: 250, attendeesMax: 50,
  /** Provider list calls per listing (Drive, Calendar). */
  listCallsMax: 40,
  /** Stored documents read back per run to compute changes and deletions. */
  storedDocumentsMax: 5_000,
  slackThreadsMax: 1_000,
} as const;

/** Handler dependencies for the three integration-backed kinds. */
export interface BrainConnectorHandlerDeps {
  readonly kysely: Kysely<BrainDatabase>;
  readonly integrations: BrainIntegrationCaller;
  /** Whether an integration transport is bound at all; false: the kind is not_configured, whatever isConnected says. */
  readonly isConfigured?: () => boolean;
  /** Whether the owner has an account for the service (no provider call). Absent: the kind is not_configured. */
  readonly isConnected?: (ownerId: string, service: BrainIntegrationService) => Promise<boolean>;
  /** Labels of the owner's connections of the service (no provider call). Present: runs use only a pinned account. */
  readonly accounts?: (ownerId: string, service: BrainIntegrationService) => Promise<readonly string[]>;
  readonly providerTimeoutMs?: number;
}

/** One captured Company Brain document (PR #2078) as CompanyBrainService.export returns it; untrusted, validated. */
export interface BrainSlackCaptureDocument {
  readonly sourceId: string; readonly title: string; readonly text: string; readonly permalink: string;
  readonly provenance: string; readonly sourceUpdatedAt: string; readonly updatedAt: string;
}

export type BrainSlackCaptureOutcome =
  | { readonly status: "ok"; readonly documents: readonly BrainSlackCaptureDocument[]; readonly truncated: boolean }
  | { readonly status: "forbidden" } | { readonly status: "not_found" } | { readonly status: "unavailable" };

/**
 * Reads the live documents of one Company Brain scope under the owner's current authority (no cached grant).
 * At most `limit` documents; never throws for expected states; rejects only on abort.
 */
export interface BrainSlackCaptureReader {
  readThreads(ownerId: string, companyScopeId: string, limit: number, signal: AbortSignal):
    Promise<BrainSlackCaptureOutcome>;
}

export interface BrainSlackBridgeHandlerDeps {
  readonly kysely: Kysely<BrainDatabase>;
  /** Absent until the Company Brain capture code is merged and wired: the kind answers not_configured. */
  readonly capture?: BrainSlackCaptureReader;
  readonly providerTimeoutMs?: number;
}
