/**
 * Sources service: the kind registry (one handler per connectable kind), the integration service whose account each
 * kind reads through, account pinning at connect time and the deadline every call outside the store gets. Pure apart
 * from the account lookup it is given.
 */
import { BrainApiError } from "../../api/types.js";
import {
  BRAIN_SOURCE_KINDS, BrainFeatureError, type BrainAnySourceKindHandler, type BrainConnectableSourceKind,
  type BrainIntegrationService, type BrainSourceKind, type BrainSourcesServiceDeps,
} from "../../contracts.js";

/** Every kind POST /sources connects, in display order. */
export const BRAIN_CONNECTABLE_SOURCE_KINDS: readonly BrainConnectableSourceKind[] = Object.values(BRAIN_SOURCE_KINDS)
  .filter((kind): kind is BrainConnectableSourceKind => kind !== "git");

/** Kinds whose config names an account of an integration service (github only in integration mode). */
export const BRAIN_SOURCE_ACCOUNT_SERVICES: Readonly<Partial<Record<BrainConnectableSourceKind, BrainIntegrationService>>> = {
  github: "github", linear: "linear", google_drive: "google_drive", google_calendar: "google_calendar",
};

/** Account labels read per lookup; an owner with more connections of one service is refused as ambiguous. */
export const BRAIN_SOURCE_ACCOUNTS_MAX = 50;

/** The owner's connection labels of a service, without a provider call (the contract's accounts seam). */
export type BrainSourceAccounts = NonNullable<BrainSourcesServiceDeps["accounts"]>;

export interface BrainSourceKindRegistry {
  /** The handler of a connectable kind, or null for git, unknown kinds and kinds this server has no handler for. */
  get(kind: string): BrainAnySourceKindHandler | null;
  readonly kinds: readonly BrainConnectableSourceKind[];
}

export function isBrainSourceKind(kind: string): kind is BrainSourceKind {
  return kind === "git" || isBrainConnectableSourceKind(kind);
}

export function isBrainConnectableSourceKind(kind: string): kind is BrainConnectableSourceKind {
  return (BRAIN_CONNECTABLE_SOURCE_KINDS as readonly string[]).includes(kind);
}

/** One handler per connectable kind; a duplicate or a kind outside the contract is a wiring error and throws. */
export function createBrainSourceKindRegistry(handlers: readonly BrainAnySourceKindHandler[]): BrainSourceKindRegistry {
  const byKind: Partial<Record<BrainConnectableSourceKind, BrainAnySourceKindHandler>> = {};
  for (const handler of handlers) {
    if (!isBrainConnectableSourceKind(handler.kind)) throw new TypeError("Unknown brain source kind handler");
    if (byKind[handler.kind] !== undefined) throw new TypeError("Duplicate brain source kind handler");
    byKind[handler.kind] = handler;
  }
  const kinds = BRAIN_CONNECTABLE_SOURCE_KINDS.filter((kind) => byKind[kind] !== undefined);
  return {
    kinds,
    get: (kind) => isBrainConnectableSourceKind(kind) ? byKind[kind] ?? null : null,
  };
}

/** Thrown when a call outside the store passes its deadline; the service maps it per call site. */
export class BrainSourcesDeadlineError extends Error {
  constructor() {
    super("Brain sources call timed out");
    this.name = "BrainSourcesDeadlineError";
  }
}

/**
 * Runs `work` with a signal that aborts after `ms` and stops waiting then, even if the callee ignores the signal.
 * The abort listener is removed when the call settles, so nothing rejects later.
 */
export async function withSourcesDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const settled = new AbortController();
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new BrainSourcesDeadlineError()), { once: true, signal: settled.signal });
  });
  try {
    return await Promise.race([work(signal), aborted]);
  } finally {
    settled.abort();
  }
}

/** Keys (owner, scope, kind) with a connect running or waiting in this process. */
export const BRAIN_SOURCES_CONNECT_QUEUE_MAX_KEYS = 64;

/**
 * Runs the work for one key after the work already queued for it, so connects of one kind in one scope never race
 * in this process. At most BRAIN_SOURCES_CONNECT_QUEUE_MAX_KEYS keys at once (more is brain_unavailable); a key is
 * dropped when its last work settles.
 */
export function createBrainSourcesConnectQueue(maxKeys = BRAIN_SOURCES_CONNECT_QUEUE_MAX_KEYS) {
  const tails = new Map<string, Promise<void>>();
  return async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key);
    if (previous === undefined && tails.size >= maxKeys) {
      console.error("[brain-sources] too many connects at once");
      throw new BrainApiError("brain_unavailable");
    }
    const { promise: current, resolve: release } = Promise.withResolvers<void>();
    const tail = (previous ?? Promise.resolve()).then(() => current);
    tails.set(key, tail);
    try {
      await previous;
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

type AccountConfig = { readonly accountLabel?: unknown; readonly mode?: unknown };

/** The service whose account this config reads through, or null (no account, or GitHub token mode). */
export function accountServiceOf(kind: BrainConnectableSourceKind, config: unknown): BrainIntegrationService | null {
  const service = BRAIN_SOURCE_ACCOUNT_SERVICES[kind];
  if (service === undefined || typeof config !== "object" || config === null) return null;
  return kind === "github" && (config as AccountConfig).mode === "token" ? null : service;
}

/**
 * An update that names no account keeps the account the stored config pinned; the result is parsed again.
 * Kinds without an account, and configs that name one, are returned as they are.
 */
export function keepStoredAccount(handler: BrainAnySourceKindHandler, config: unknown, stored: unknown): unknown {
  if (accountServiceOf(handler.kind, config) === null) return config;
  const label = (stored as AccountConfig | null)?.accountLabel;
  if ((config as AccountConfig).accountLabel !== undefined || typeof label !== "string") return config;
  return handler.parseConfig({ ...(config as object), accountLabel: label });
}

/**
 * Pins the account a source reads through, before identify (the label is part of a connector's identity). Without an
 * account lookup the config is returned as is. A named label must be one of the owner's connections
 * (source_not_connected); with none named the owner's only connection is pinned; none is source_not_connected and
 * several is source_config_invalid (the client must name one). Never "the first" of several.
 */
export async function pinSourceAccount(
  handler: BrainAnySourceKindHandler, ownerId: string, config: unknown, accounts: BrainSourceAccounts | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const service = accountServiceOf(handler.kind, config);
  if (service === null || accounts === undefined) return config;
  const labels = (await withSourcesDeadline(timeoutMs, () => accounts(ownerId, service)))
    .slice(0, BRAIN_SOURCE_ACCOUNTS_MAX + 1);
  const named = (config as AccountConfig).accountLabel;
  if (typeof named === "string") {
    if (!labels.includes(named)) throw new BrainFeatureError("source_not_connected");
    return config;
  }
  if (labels.length === 0) throw new BrainFeatureError("source_not_connected");
  if (labels.length > 1) throw new BrainFeatureError("source_config_invalid");
  return handler.parseConfig({ ...(config as object), accountLabel: labels[0] });
}
