import { AppError } from "../../../../shared/app-error";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { QueryClient } from "@tanstack/react-query";
import type { ApiClient } from "../../lib/api";
import { fetchCanonicalProviderCatalog } from "./provider-catalog-client";

export const PROVIDER_CATALOG_FRESH_MS = 5 * 60_000;
export const PROVIDER_CATALOG_WAKE_CHECK_MS = 30_000;
const RETRY_DELAYS = [30_000, 120_000, PROVIDER_CATALOG_FRESH_MS];
const QUERY_KEY = ["desktop", "provider-catalog"] as const;
const REFRESH_ERROR = "Model availability could not be updated.";

export interface ProviderCatalogBinding {
  identityKey: string;
  generation: number;
  api: Pick<ApiClient, "get">;
  /** null means the change's authority scope is unknown. */
  affectedInstanceIds?: readonly string[] | null;
}
export interface ProviderCatalogSnapshot {
  identityKey: string | null;
  generation: number;
  catalog: CanonicalProviderCatalog | null;
  refreshing: boolean;
  lastSuccessAt: number | null;
  refreshError: string | null;
  suspendedInstanceIds: readonly string[] | null;
  authoritySuspended: boolean;
}
const EMPTY: ProviderCatalogSnapshot = {
  identityKey: null, generation: 0, catalog: null, refreshing: false,
  lastSuccessAt: null, refreshError: null, suspendedInstanceIds: null, authoritySuspended: false,
};

function semanticCatalog(catalog: CanonicalProviderCatalog): string {
  return JSON.stringify({ ...catalog, revision: undefined,
    instances: catalog.instances.map(instance => ({ ...instance, catalogRevision: undefined })) });
}

/** Owns one current runtime entry, one request and one timer. Consumer lifetime is irrelevant. */
export class ProviderCatalogCache {
  private binding: ProviderCatalogBinding | null = null;
  private request: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private epoch = 0;
  private queuedForce = false;
  private failures = 0;
  private nextReadAt = 0;
  private online = true;

  constructor(private readonly client: QueryClient) {
    client.setQueryDefaults(QUERY_KEY, { gcTime: Infinity });
  }
  getSnapshot = (): ProviderCatalogSnapshot => this.client.getQueryData(QUERY_KEY) ?? EMPTY;
  subscribe = (listener: () => void): (() => void) => this.client.getQueryCache().subscribe(event => {
    if (event.query.queryKey[0] === QUERY_KEY[0] && event.query.queryKey[1] === QUERY_KEY[1]) listener();
  });

  observe(binding: ProviderCatalogBinding | null): void {
    if (!binding) {
      if (this.binding) this.clear();
      return;
    }
    if (this.binding?.identityKey !== binding.identityKey) {
      this.clear();
      this.binding = binding;
      this.publish({ ...EMPTY, identityKey: binding.identityKey, generation: binding.generation });
      this.read(false);
      return;
    }
    const changed = this.binding.generation !== binding.generation;
    this.binding = binding; // New ApiClient objects do not invalidate same-scope display data.
    if (!changed) return;
    this.epoch += 1;
    const current = this.getSnapshot();
    const affected = binding.affectedInstanceIds ?? null;
    const suspendedInstanceIds = current.authoritySuspended
      ? current.suspendedInstanceIds === null || affected === null ? null
        : current.catalog?.instances.filter(i => current.suspendedInstanceIds?.includes(i.id) || affected.includes(i.id)).map(i => i.id) ?? []
      : affected;
    this.publish({ ...current, generation: binding.generation, authoritySuspended: true, suspendedInstanceIds });
    this.refresh();
  }

  refresh = (): void => {
    if (!this.binding) return;
    this.clearTimer();
    if (this.request || !this.online) {
      this.queuedForce = true;
      // A post-change observation supersedes the older pending result.
      if (this.request) this.epoch += 1;
      return;
    }
    this.read(true);
  };

  setOnline(online: boolean): void {
    this.online = online;
    if (!online) { this.clearTimer(); return; }
    if (this.queuedForce) this.read(true);
    else if (Date.now() >= this.nextReadAt) this.read(false);
    else this.schedule();
  }

  clear(): void {
    this.clearTimer();
    this.epoch += 1;
    this.request?.abort();
    this.request = null;
    this.binding = null;
    this.queuedForce = false;
    this.failures = 0;
    this.nextReadAt = 0;
    this.client.removeQueries({ queryKey: QUERY_KEY, exact: true });
  }

  private publish(snapshot: ProviderCatalogSnapshot): void {
    this.client.setQueryData(QUERY_KEY, snapshot);
  }
  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(): void {
    this.clearTimer();
    if (!this.binding || !this.online || this.request) return;
    // Renderer timers pause during OS sleep. Their elapsed wall-clock deadline
    // starts one due read on wake, without focus/visibility listeners.
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.queuedForce || Date.now() >= this.nextReadAt) this.read(this.queuedForce);
      else this.schedule();
    }, Math.min(PROVIDER_CATALOG_WAKE_CHECK_MS, Math.max(0, this.nextReadAt - Date.now())));
  }
  private read(force: boolean): void {
    if (!this.binding || this.request || !this.online) return;
    this.clearTimer();
    this.queuedForce = false;
    const binding = this.binding;
    const epoch = this.epoch;
    const request = new AbortController();
    this.request = request;
    this.publish({ ...this.getSnapshot(), refreshing: true });
    void fetchCanonicalProviderCatalog(binding.api, force, request.signal).then(catalog => {
      if (this.request !== request || this.epoch !== epoch || request.signal.aborted) return;
      const previous = this.getSnapshot();
      const unchanged = previous.catalog && semanticCatalog(previous.catalog) === semanticCatalog(catalog);
      this.failures = 0;
      this.nextReadAt = Date.now() + PROVIDER_CATALOG_FRESH_MS;
      this.publish({ identityKey: binding.identityKey, generation: binding.generation,
        catalog: unchanged ? previous.catalog : catalog, refreshing: false,
        lastSuccessAt: Date.now(), refreshError: null, authoritySuspended: false, suspendedInstanceIds: null });
    }).catch((error: unknown) => {
      if (this.request !== request || this.epoch !== epoch || request.signal.aborted) return;
      console.warn("[chat] Provider catalog unavailable:", error instanceof Error ? error.name : "UnknownError");
      const delay = RETRY_DELAYS[Math.min(this.failures++, RETRY_DELAYS.length - 1)] ?? PROVIDER_CATALOG_FRESH_MS;
      this.nextReadAt = Date.now() + delay + Math.floor(Math.random() * delay * 0.1);
      this.publish({ ...this.getSnapshot(), refreshing: false, refreshError: REFRESH_ERROR,
        ...(error instanceof AppError && error.category === "unauthorized"
          ? { authoritySuspended: true, suspendedInstanceIds: null } : {}) });
    }).finally(() => {
      if (this.request !== request) return;
      this.request = null;
      if (this.queuedForce && this.online) this.read(true);
      else {
        this.publish({ ...this.getSnapshot(), refreshing: false });
        this.schedule();
      }
    });
  }
}
