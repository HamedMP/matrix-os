/**
 * createBrainSourcesService: the owner-scoped /sources service. Every call resolves the caller's project first (a
 * missing, foreign or malformed project is project_not_found), then the source inside that project's scope (a
 * missing, foreign, tombstoned or malformed source is source_not_found). Connect runs parseConfig, account pinning,
 * identify, checkConfig, createSource, saveConfig, and removes the new source again when anything after createSource
 * fails, so a refused config never leaves a live source. Sync is exactly one bounded run of the shared runner (git
 * sources delegate to gitSync). Holds no state between calls; every call outside the store has a deadline.
 */
import { BrainApiError } from "../../api/types.js";
import {
  BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_SOURCE_CONFIG_LIMITS, BRAIN_SOURCE_OPTIONS_MAX, BRAIN_SOURCES_PER_KIND_MAX,
  BrainFeatureError, type BrainAnySourceKindHandler, type BrainConnectableSourceKind, type BrainResolvedProject,
  type BrainSourceConfigView, type BrainSourceKind, type BrainSourceKindView, type BrainSourceOptionsView,
  type BrainSourcesService, type BrainSourcesServiceDeps, type BrainSourceSyncResult, type BrainSourceSyncView,
  type BrainSourceView,
} from "../../contracts.js";
import {
  BRAIN_LIST_MAX_LIMIT, BRAIN_RECEIPTS_PER_SOURCE, BRAIN_SOURCE_ID_PATTERN, type BrainScopeKey, type BrainSource,
} from "../../types.js";
import {
  BRAIN_CONNECTABLE_SOURCE_KINDS, BrainSourcesDeadlineError, createBrainSourceKindRegistry, createBrainSourcesConnectQueue,
  isBrainSourceKind,
  keepStoredAccount, pinSourceAccount, withSourcesDeadline,
} from "./registry.js";
import { toLastSyncView, toReceiptView, toSourceSyncView, toSourceView } from "./views.js";

export const BRAIN_SOURCES_SERVICE_LIMITS = {
  /** Pages of live sources read per scope (100 each); every kind's cap fits many times over. */
  scanPages: 5,
  /** Sources a list shows, oldest first. */
  viewMax: 50,
  /** Default and bounds of each availability, account, adapter and option call. */
  callTimeoutMs: 10_000, callTimeoutMinMs: 100, callTimeoutMaxMs: 30_000,
  receiptsDefault: 10,
  /** Option ids longer than a config list item are dropped; labels and details are cut. */
  optionTextMaxChars: 200,
} as const;

/** The contract's deps plus the deadline of each call outside the store (clamped to callTimeoutMinMs..MaxMs). */
export interface BrainSourcesCoreDeps extends BrainSourcesServiceDeps {
  readonly callTimeoutMs?: number;
  /**
   * Drops the derived rows (search, graph, brief) of the documents a removal tombstoned, before the answer; true when
   * it finished. Absent or false: the removal is announced as documents_changed instead.
   */
  readonly purgeRemoved?: (scope: BrainScopeKey, removed: BrainSource) => Promise<boolean>;
}

type KnownSource = BrainSource & { readonly kind: BrainSourceKind };
const ADAPTER_ERRORS = {
  not_connected: "source_not_connected", auth_failed: "source_auth_failed", config_invalid: "source_config_invalid",
} as const;
const LIMITS = BRAIN_SOURCES_SERVICE_LIMITS;

function isKnown(source: BrainSource): source is KnownSource {
  return isBrainSourceKind(source.kind);
}

function byAge(left: BrainSource, right: BrainSource): number {
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1;
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A deadline passed outside the store is an outage for this request (503), logged by where it happened. */
function outage(where: string, error: unknown): unknown {
  if (!(error instanceof BrainSourcesDeadlineError)) return error;
  console.error(`[brain-sources] ${where} timed out`);
  return new BrainApiError("brain_unavailable", { cause: error });
}

/** Like Promise.all, but waits for every call to settle before it rejects, so no read is left running. */
async function settleAll<T>(calls: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(calls);
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed !== undefined) throw failed.reason;
  return settled.map((result) => (result as PromiseFulfilledResult<T>).value);
}

function cutText(value: string): string {
  return value.length <= LIMITS.optionTextMaxChars ? value : value.slice(0, LIMITS.optionTextMaxChars);
}

/** Bounded option output whatever a handler returns: at most 100 items, short ids, cut text, a bounded cursor. */
function boundOptions(kind: BrainConnectableSourceKind, view: BrainSourceOptionsView): BrainSourceOptionsView {
  const items = view.items.slice(0, BRAIN_SOURCE_OPTIONS_MAX)
    .filter((item) => item.id.length > 0 && item.id.length <= BRAIN_SOURCE_CONFIG_LIMITS.listItemMaxChars)
    .map((item) => ({ id: item.id, label: cutText(item.label), detail: item.detail === null ? null : cutText(item.detail) }));
  const cursor = view.nextCursor;
  return { kind, items, nextCursor: cursor !== null && cursor.length <= BRAIN_FEATURE_CURSOR_MAX_CHARS ? cursor : null };
}

/** The store keeps earlier revisions: turning calendar event bodies off removes and reconnects the source. */
function purgesHistory(kind: BrainConnectableSourceKind, stored: unknown, next: unknown): boolean {
  const before = stored as { includeEventBodies?: unknown } | null;
  return kind === "google_calendar" && before?.includeEventBodies === true
    && (next as { includeEventBodies?: unknown }).includeEventBodies === false;
}
