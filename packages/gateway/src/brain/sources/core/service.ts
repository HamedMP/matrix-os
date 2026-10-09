/**
 * createBrainSourcesService: the owner-scoped /sources service. Every call resolves the caller's project first (a
 * missing, foreign or malformed project is project_not_found), then the source inside that project's scope (a
 * missing, foreign, tombstoned or malformed source is source_not_found). Connect runs parseConfig, account pinning,
 * identify, checkConfig, then createSource with saveConfig in its transaction, so a refused config never leaves a live
 * source. An update saves the config in the transaction that moves the revision, or that replaces the source when the
 * config needs a reconnect. Sync is exactly one bounded run of the shared runner (the project's git source delegates
 * to gitSync).
 * Holds no state between calls; every call outside the store has a deadline.
 */
import { BrainApiError } from "../../api/types.js";
import {
  BRAIN_FEATURE_CURSOR_MAX_CHARS, BRAIN_SOURCE_CONFIG_LIMITS, BRAIN_SOURCE_NEXT_ACTIONS, BRAIN_SOURCE_OPTIONS_MAX,
  BRAIN_SOURCES_PER_KIND_MAX,
  BrainFeatureError, type BrainAnySourceKindHandler, type BrainConnectableSourceKind, type BrainResolvedProject,
  type BrainSourceConfigView, type BrainSourceKind, type BrainSourceKindView, type BrainSourceOptionsView,
  type BrainSourcesService, type BrainSourcesServiceDeps, type BrainSourceSyncResult, type BrainSourceSyncView,
  type BrainSourceView,
} from "../../contracts.js";
import {
  BRAIN_LIST_MAX_LIMIT, BRAIN_RECEIPTS_PER_SOURCE, BRAIN_SOURCE_ID_PATTERN, BrainStoreError, type BrainScopeKey,
  type BrainSource,
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
  /** Tries at saving a missing config while renames or pauses move the revision; then connect is source_conflict. */
  repairAttempts: 3,
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
/** What the runner answers for a source that is not active; sync answers it for a paused source of any kind. */
const INACTIVE: BrainSourceSyncResult = {
  status: "failed", errorCode: "source_inactive", nextAction: BRAIN_SOURCE_NEXT_ACTIONS.source_inactive, receipt: null,
  counts: { read: 0, written: 0, unchanged: 0, deleted: 0, failed: 0 }, caughtUp: false, pages: 0, skipped: 0,
  retryAfterSeconds: null, rejectedDocumentIds: [], notices: [],
};

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

type RestartFields = {
  readonly includeEventBodies?: unknown; readonly since?: unknown;
  readonly include?: { readonly pullRequests?: unknown; readonly reviews?: unknown; readonly issues?: unknown };
};

/** What a GitHub source reads: the window start and the item types. */
function githubReads(config: RestartFields): string {
  return JSON.stringify([config.since ?? null, config.include?.pullRequests, config.include?.reviews, config.include?.issues]);
}

/**
 * Config changes the source's stored documents or cursor cannot follow, so the source is removed and connected again:
 * calendar event bodies turned off (the store keeps earlier revisions), and a GitHub `since` or `include` change (the
 * cursor's watermark and done list were read under the old ones, so older items would never be read).
 */
function restartsSource(kind: BrainConnectableSourceKind, stored: unknown, next: unknown): boolean {
  if (stored === null) return false;
  const before = stored as RestartFields;
  const after = next as RestartFields;
  if (kind === "google_calendar") return before.includeEventBodies === true && after.includeEventBodies === false;
  if (kind !== "github") return false;
  return githubReads(before) !== githubReads(after);
}

export function createBrainSourcesService(deps: BrainSourcesCoreDeps): BrainSourcesService {
  const registry = createBrainSourceKindRegistry(deps.handlers);
  const repository = deps.repository;
  const queue = createBrainSourcesConnectQueue();
  const queueKey = (scope: BrainScopeKey, kind: string) => JSON.stringify([scope.ownerId, scope.scopeId, kind]);
  const timeoutMs = Math.min(LIMITS.callTimeoutMaxMs,
    Math.max(LIMITS.callTimeoutMinMs, Math.floor(deps.callTimeoutMs ?? LIMITS.callTimeoutMs)));

  /** Live sources of known kinds, oldest first, at most scanPages pages. */
  async function scan(scope: BrainScopeKey): Promise<KnownSource[]> {
    const found: KnownSource[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < LIMITS.scanPages; page += 1) {
      const result = await repository.listSources(scope, { limit: BRAIN_LIST_MAX_LIMIT, cursor });
      for (const source of result.items) if (isKnown(source)) found.push(source);
      cursor = result.nextCursor;
      if (cursor === null) break;
    }
    return found.sort(byAge);
  }

  async function liveSource(scope: BrainScopeKey, sourceId: string): Promise<KnownSource> {
    if (!BRAIN_SOURCE_ID_PATTERN.test(sourceId)) throw new BrainFeatureError("source_not_found");
    const source = await repository.getSource(scope, sourceId);
    if (source === null || !isKnown(source)) throw new BrainFeatureError("source_not_found");
    return source;
  }

  function handlerOf(kind: string): BrainAnySourceKindHandler {
    const handler = registry.get(kind);
    if (handler === null) throw new BrainFeatureError("source_kind_unsupported");
    return handler;
  }

  /** The stored config, or null when there is none or the schema now refuses it (logged; an update replaces it). */
  async function storedConfig(
    handler: BrainAnySourceKindHandler, scope: BrainScopeKey, sourceId: string,
  ): Promise<unknown> {
    try {
      return await handler.loadConfig(scope, sourceId);
    } catch (error: unknown) {
      if (!(error instanceof BrainFeatureError) || error.code !== "source_config_invalid") throw error;
      console.warn("[brain-sources] stored config refused:", handler.kind);
      return null;
    }
  }

  async function configView(scope: BrainScopeKey, source: KnownSource): Promise<BrainSourceConfigView | null> {
    const handler = registry.get(source.kind);
    if (handler === null) return null;
    const config = await storedConfig(handler, scope, source.sourceId);
    return config === null ? null : handler.viewConfig(config);
  }

  async function view(scope: BrainScopeKey, source: KnownSource): Promise<BrainSourceView> {
    const config = configView(scope, source);
    const receipts = repository.listSyncReceipts(scope, source.sourceId, { limit: 1 });
    // Both reads settle before either error is thrown.
    await Promise.allSettled([config, receipts]);
    return toSourceView(source, await config, toLastSyncView((await receipts)[0]));
  }

  /** An availability check that fails or passes its deadline reads as not_configured (logged by error name). */
  async function kindView(ownerId: string, kind: BrainSourceKind): Promise<BrainSourceKindView> {
    if (kind === "git") {
      return deps.gitSync === undefined
        ? { kind, available: false, reason: "not_configured" } : { kind, available: true, reason: null };
    }
    const handler = registry.get(kind);
    if (handler === null) return { kind, available: false, reason: "not_configured" };
    try {
      const result = await withSourcesDeadline(timeoutMs, () => handler.availability(ownerId));
      return result.available ? { kind, available: true, reason: null } : { kind, available: false, reason: result.reason };
    } catch (error: unknown) {
      console.warn(`[brain-sources] ${kind} availability failed:`, errorName(error));
      return { kind, available: false, reason: "not_configured" };
    }
  }

  async function requireAvailable(ownerId: string, handler: BrainAnySourceKindHandler): Promise<void> {
    const result = await withSourcesDeadline(timeoutMs, () => handler.availability(ownerId))
      .catch((error: unknown) => { throw outage(`${handler.kind} availability`, error); });
    if (result.available) return;
    throw new BrainFeatureError(result.reason === "not_connected" ? "source_not_connected" : "source_kind_unsupported");
  }

  async function pin(ownerId: string, handler: BrainAnySourceKindHandler, config: unknown): Promise<unknown> {
    return pinSourceAccount(handler, ownerId, config, deps.accounts, timeoutMs)
      .catch((error: unknown) => { throw outage(`${handler.kind} account lookup`, error); });
  }

  /**
   * Whether `source` is among the oldest BRAIN_SOURCES_PER_KIND_MAX live sources of its kind, by (createdAt, sourceId).
   * Connects in this process are queued; this check settles a race with another process (a later create always sees
   * the earlier one).
   */
  async function withinKindCap(scope: BrainScopeKey, source: KnownSource): Promise<boolean> {
    const peers = (await scan(scope)).filter((peer) => peer.kind === source.kind);
    const rank = peers.findIndex((peer) => peer.sourceId === source.sourceId);
    return rank < BRAIN_SOURCES_PER_KIND_MAX[source.kind];
  }

  /** Removes a source this request created; a failure here is logged and the original error stands. */
  async function rollback(scope: BrainScopeKey, source: BrainSource): Promise<void> {
    try {
      await repository.deleteSource(scope, { sourceId: source.sourceId, expectedRevision: source.revision });
    } catch (error: unknown) {
      console.error("[brain-sources] connect rollback failed:", errorName(error));
    }
  }

  /**
   * createSource with saveConfig in its transaction, so no request sees the new source without its config; the new
   * source is removed again when the cap refuses it. The same identity again changes nothing, but a missing (or now
   * refused) config gets this one, compare-and-set on the revision read with it: a config saved since then stands,
   * and a rename or pause since then is read again and the save retried (repairAttempts, then source_conflict).
   */
  async function createWithConfig(
    scope: BrainScopeKey, handler: BrainAnySourceKindHandler, config: unknown,
    row: { readonly externalRef: string; readonly label: string },
  ): Promise<{ readonly source: KnownSource; readonly created: boolean }> {
    const { source, created } = await repository.createSource(scope, { kind: handler.kind, ...row },
      (trx, next) => handler.saveConfig(scope, next.sourceId, config, trx));
    const known: KnownSource = { ...source, kind: handler.kind };
    if (created) {
      try {
        if (!await withinKindCap(scope, known)) throw new BrainFeatureError("source_conflict");
      } catch (error: unknown) {
        await rollback(scope, source);
        throw error;
      }
      return { source: known, created };
    }
    let current = known;
    for (let attempt = 1; ; attempt += 1) {
      if (await storedConfig(handler, scope, current.sourceId) !== null) return { source: current, created };
      try {
        const repaired = await repository.updateSource(scope, {
          sourceId: current.sourceId, expectedRevision: current.revision, label: current.label,
        }, (trx) => handler.saveConfig(scope, current.sourceId, config, trx));
        return { source: { ...repaired, kind: handler.kind }, created };
      } catch (error: unknown) {
        if (!(error instanceof BrainStoreError) || error.code !== "conflict") throw error;
        if (attempt >= LIMITS.repairAttempts) throw new BrainFeatureError("source_conflict", { cause: error });
      }
      current = await liveSource(scope, source.sourceId);
    }
  }

  /** The removed source's derived rows go before the answer; what the purge could not finish goes by change event. */
  async function afterRemove(scope: BrainScopeKey, removed: BrainSource): Promise<void> {
    if (deps.purgeRemoved !== undefined && await deps.purgeRemoved(scope, removed)) return;
    deps.hooks?.emit({
      type: "documents_changed", scope, sourceId: removed.sourceId, documentIds: null, at: new Date().toISOString(),
    });
  }

  /** Runner results that ended before a receipt: busy is 409, a vanished source 404, a paused one a 200 view. */
  function syncView(sourceId: string, result: BrainSourceSyncResult): BrainSourceSyncView {
    if (result.receipt === null) {
      if (result.errorCode === "sync_in_progress") throw new BrainApiError("sync_in_progress");
      if (result.errorCode === "source_unavailable") throw new BrainFeatureError("source_not_found");
      if (result.status === "failed" && result.errorCode !== "source_inactive") {
        console.error("[brain-sources] sync could not record a receipt:", result.errorCode);
        throw new BrainApiError("brain_unavailable");
      }
    }
    return toSourceSyncView(sourceId, result);
  }

  /**
   * gitSync runs the project's git source: the oldest live one, as the project service picks it. Another git source (a
   * registration race left two) is source_conflict, never synced under the wrong id (the project service checks the id
   * again as the run starts). A paused one answers like the runner; one paused or removed while the run started
   * answers the same way. The caller's signal stops the run before a window and kills a running git command.
   */
  async function gitSyncView(
    ownerId: string, projectRef: string, scope: BrainScopeKey, source: KnownSource, signal: AbortSignal | undefined,
  ): Promise<BrainSourceSyncView> {
    const gitSync = deps.gitSync;
    if (gitSync === undefined) throw new BrainFeatureError("source_kind_unsupported");
    const projectGit = (await scan(scope)).find((peer) => peer.kind === "git");
    if (projectGit === undefined) throw new BrainFeatureError("source_not_found");
    if (projectGit.sourceId !== source.sourceId) throw new BrainFeatureError("source_conflict");
    if (projectGit.status !== "active") return syncView(source.sourceId, INACTIVE);
    try {
      const run = { sourceId: source.sourceId, ...(signal === undefined ? {} : { signal }) };
      return { ...(await gitSync(ownerId, projectRef, run)), sourceId: source.sourceId };
    } catch (error: unknown) {
      if (error instanceof BrainApiError && error.code === "git_source_conflict") {
        throw new BrainFeatureError("source_conflict", { cause: error });
      }
      if (!(error instanceof BrainApiError)
        || (error.code !== "git_source_unavailable" && error.code !== "git_source_missing")) throw error;
      const current = await repository.getSource(scope, source.sourceId);
      if (current === null) throw new BrainFeatureError("source_not_found", { cause: error });
      if (current.status !== "active") return syncView(source.sourceId, INACTIVE);
      throw error;
    }
  }

  async function updateConfig(
    ownerId: string, project: BrainResolvedProject, source: KnownSource, input: Parameters<BrainSourcesService["update"]>[3],
  ): Promise<BrainSourceView> {
    const scope = project.scope;
    const handler = handlerOf(source.kind);
    const stored = await storedConfig(handler, scope, source.sourceId);
    const config = await pin(ownerId, handler, keepStoredAccount(handler, handler.parseConfig(input.config), stored));
    // The identity names the source: a config naming other items, roots or another account is a new source.
    if (handler.identify(project, config).externalRef !== source.externalRef) {
      throw new BrainFeatureError("source_config_invalid");
    }
    await handler.checkConfig?.(scope, config);
    const label = input.label ?? source.label;
    const status = input.status ?? source.status;
    if (restartsSource(handler.kind, stored, config)) {
      // Removed and connected again in one transaction with the new config: a failed save leaves the old source, its
      // documents and its config as they were, and the new source is never seen without its config. It keeps the old
      // one's place among its kind, so the per-kind cap is unchanged.
      const { removed, source: again } = await repository.replaceSource(scope, {
        sourceId: source.sourceId, expectedRevision: input.expectedRevision, label, status,
      }, (trx, next) => handler.saveConfig(scope, next.sourceId, config, trx));
      await afterRemove(scope, removed);
      return view(scope, { ...again, kind: source.kind });
    }
    // The config is written in the transaction that moves the revision: both land or neither does, and a client that
    // reads the new revision always sees the new config, so it never saves an older one over it.
    const updated = await repository.updateSource(scope, {
      sourceId: source.sourceId, expectedRevision: input.expectedRevision, label, status,
    }, (trx) => handler.saveConfig(scope, source.sourceId, config, trx));
    return view(scope, { ...updated, kind: source.kind });
  }

  return {
    async list(ownerId, projectRef) {
      const { scope } = await deps.resolver.resolve(ownerId, projectRef);
      const sources = (await scan(scope)).slice(0, LIMITS.viewMax);
      const items = await settleAll(sources.map((source) => view(scope, source)));
      const kinds = await settleAll((["git", ...BRAIN_CONNECTABLE_SOURCE_KINDS] as const)
        .map((kind) => kindView(ownerId, kind)));
      return { items, kinds };
    },

    async connect(ownerId, projectRef, input) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const scope = project.scope;
      const handler = handlerOf(input.kind);
      await requireAvailable(ownerId, handler);
      const config = await pin(ownerId, handler, handler.parseConfig(input.config));
      const identity = handler.identify(project, config);
      await handler.checkConfig?.(scope, config);
      const result = await queue(queueKey(scope, handler.kind), async () => {
        const peers = (await scan(scope)).filter((peer) => peer.kind === handler.kind);
        const same = peers.some((peer) => peer.externalRef === identity.externalRef);
        if (!same && peers.length >= BRAIN_SOURCES_PER_KIND_MAX[handler.kind]) {
          throw new BrainFeatureError("source_conflict");
        }
        return createWithConfig(scope, handler, config, {
          externalRef: identity.externalRef, label: input.label ?? identity.label,
        });
      });
      return { source: await view(scope, result.source), created: result.created };
    },

    async options(ownerId, projectRef, kind, query) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const handler = handlerOf(kind);
      // The same answer connect gives for a kind that cannot be connected, never an empty list that reads as "none".
      await requireAvailable(ownerId, handler);
      const listOptions = handler.listOptions;
      if (listOptions === undefined) return { kind: handler.kind, items: [], nextCursor: null };
      const page = await withSourcesDeadline(timeoutMs, (signal) => listOptions(ownerId, project, query, signal))
        .catch((error: unknown) => { throw outage(`${kind} options`, error); });
      return boundOptions(handler.kind, page);
    },

    async update(ownerId, projectRef, sourceId, input) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const source = await liveSource(project.scope, sourceId);
      if (source.revision !== input.expectedRevision) throw new BrainFeatureError("revision_conflict");
      if (input.config !== undefined) return updateConfig(ownerId, project, source, input);
      if (input.label === undefined && input.status === undefined) throw new BrainApiError("invalid_request");
      const updated = await repository.updateSource(project.scope, {
        sourceId, expectedRevision: input.expectedRevision,
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.status === undefined ? {} : { status: input.status }),
      });
      return view(project.scope, { ...updated, kind: source.kind });
    },

    async remove(ownerId, projectRef, sourceId, expectedRevision) {
      const { scope } = await deps.resolver.resolve(ownerId, projectRef);
      const source = await liveSource(scope, sourceId);
      const removed = await repository.deleteSource(scope, { sourceId, expectedRevision });
      await afterRemove(scope, removed);
      return toSourceView({ ...removed, kind: source.kind }, null, null);
    },

    async sync(ownerId, projectRef, sourceId, signal) {
      const project = await deps.resolver.resolve(ownerId, projectRef);
      const scope = project.scope;
      const source = await liveSource(scope, sourceId);
      if (source.kind === "git") return gitSyncView(ownerId, projectRef, scope, source, signal);
      // Before the config and the account are read, so neither can turn the paused answer into an error.
      if (source.status !== "active") return syncView(sourceId, INACTIVE);
      const handler = handlerOf(source.kind);
      const config: unknown = await handler.loadConfig(scope, sourceId);
      if (config === null) throw new BrainFeatureError("source_config_invalid");
      const resolution = await withSourcesDeadline(timeoutMs, () => handler.createAdapter(ownerId, project, config))
        .catch((error: unknown) => { throw outage(`${source.kind} adapter`, error); });
      if (!resolution.ok) throw new BrainFeatureError(ADAPTER_ERRORS[resolution.code]);
      const result = await deps.runner({
        repository, scope, sourceId, adapter: resolution.adapter, config,
        ...(deps.limits === undefined ? {} : { limits: deps.limits }),
        ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
        ...(signal === undefined ? {} : { signal }),
      });
      return syncView(sourceId, result);
    },

    async receipts(ownerId, projectRef, sourceId, limit) {
      const { scope } = await deps.resolver.resolve(ownerId, projectRef);
      const source = await liveSource(scope, sourceId);
      const bounded = Math.min(BRAIN_RECEIPTS_PER_SOURCE, Math.max(1, Math.floor(limit) || LIMITS.receiptsDefault));
      const receipts = await repository.listSyncReceipts(scope, sourceId, { limit: bounded });
      return { source: await view(scope, source), receipts: receipts.map(toReceiptView) };
    },
  };
}
