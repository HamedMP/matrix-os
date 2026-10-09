import { getAction, getService } from "../registry.js";
import { validateActionParams } from "../parameter-validation.js";
import { RefreshBindingSchema, IntegrationRefreshError, REFRESH_LIMITS, publicRefreshJob, type RefreshBinding } from "./contracts.js";
import { refreshPagination } from "./pagination.js";
import { assertRefreshSupported } from "./page-shapes.js";
import { IntegrationRefreshRepository } from "./repository.js";
import { readRefreshWithDeadline } from "./deadline.js";

export class IntegrationRefreshService {
  constructor(readonly options: {
    repository: IntegrationRefreshRepository;
    /** Cheap installed-app permission check; must not contact integrations. */
    authorizeApp: (ownerId: string, binding: RefreshBinding) => Promise<boolean>;
    /** Fresh exact connection check; refresh calls it only after reserving a lease. */
    authorizeConnection: (ownerId: string, binding: RefreshBinding, signal: AbortSignal) => Promise<boolean>;
    /** Forward only the already bound read to the existing read-call executor. */
    read: (input: { ownerId: string; binding: RefreshBinding; params: Record<string, unknown>; signal: AbortSignal }) => Promise<unknown>;
    clock?: () => Date;
  }) {}
  private now() { return this.options.clock?.() ?? new Date(); }
  private async authorizeApp(ownerId: string, binding: RefreshBinding) {
    if (!(await this.options.authorizeApp(ownerId, binding))) throw new IntegrationRefreshError("denied");
  }
  async refresh(ownerId: string, raw: unknown, options: { restart?: boolean; signal?: AbortSignal } = {}) {
    const parsed = RefreshBindingSchema.safeParse(raw);
    if (!parsed.success) throw new IntegrationRefreshError("invalid");
    const binding = parsed.data;
    const definition = getService(binding.service);
    const action = getAction(binding.service, binding.action);
    // Never let discovery add a billable component fallback to a refresh operation.
    if (!definition || !action || action.risk !== "read" || (!action.directApi && definition.connectorKind === "pipedream")
      || Object.keys(binding.params).some(key => !Object.hasOwn(action.params, key))
      || !validateActionParams(action, binding.params).valid) throw new IntegrationRefreshError("invalid");
    // Validate the pagination contract before reserving a call or reading data.
    assertRefreshSupported(binding);
    await this.authorizeApp(ownerId, binding);
    const repository = this.options.repository;
    let job = await repository.ensure(ownerId, binding, this.now());
    if (options.restart) job = await repository.restart(job, this.now());
    const lease = await repository.claim(job, this.now());
    if (!lease) {
      const current = await repository.get(ownerId, binding.appId, binding.sourceId);
      if (!current || current.id !== job.id) throw new IntegrationRefreshError("conflict");
      return publicRefreshJob(current);
    }
    const params = { ...binding.params, ...lease.checkpoint, ...lease.cursor };
    // Calendar accepts larger pages than our bounded record envelope. Preserve
    // the immutable binding, but request resumable pages within the import cap.
    if (binding.service === "google_calendar" && binding.action === "list_events" && typeof params.maxResults === "number") {
      params.maxResults = Math.min(params.maxResults, REFRESH_LIMITS.maxPageRecords);
    }
    // A replacement fetches a full contacts snapshot, never a delta against
    // records that will be replaced. Preserve filters but remove any watermark.
    if (lease.replacing && binding.service === "google_contacts" && binding.action === "list_contacts") delete params.syncToken;
    if (Object.keys(params).some(key => !Object.hasOwn(action.params, key)) || !validateActionParams(action, params).valid) return publicRefreshJob(await repository.fail(lease, "source_unavailable", this.now()));
    try {
      const data = await readRefreshWithDeadline(async signal => {
        if (!(await this.options.authorizeConnection(ownerId, binding, signal))) throw new IntegrationRefreshError("denied");
        return this.options.read({ ownerId, binding, params, signal });
      }, options.signal);
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > REFRESH_LIMITS.maxPageBytes) return publicRefreshJob(await repository.fail(lease, "budget_exhausted", this.now()));
      const { cursor, checkpoint } = refreshPagination(binding, data, params);
      return publicRefreshJob(await repository.commit(lease, data, cursor, checkpoint, this.now()));
    } catch (error: unknown) {
      if (error instanceof IntegrationRefreshError && error.code === "conflict") throw error;
      console.warn("[data-imports] Refresh failed:", error instanceof Error ? error.name : "UnknownError");
      const failed = await repository.fail(lease, "source_unavailable", this.now());
      if (error instanceof IntegrationRefreshError && error.code === "denied") throw error;
      return publicRefreshJob(failed);
    }
  }
  async snapshot(ownerId: string, appId: string, sourceId: string, includePages = false) {
    const job = await this.options.repository.get(ownerId, appId, sourceId);
    if (!job) throw new IntegrationRefreshError("invalid");
    await this.authorizeApp(ownerId, job.binding);
    if (!(await readRefreshWithDeadline(signal => this.options.authorizeConnection(ownerId, job.binding, signal), undefined, 10000))) throw new IntegrationRefreshError("denied");
    return includePages ? { pages: await this.options.repository.pages(ownerId, job.id) } : publicRefreshJob(job);
  }
  async remove(ownerId: string, appId: string, sourceId: string) {
    // Owner scope is authenticated by the route; removal must still work after connection/app revocation.
    await this.options.repository.remove(ownerId, appId, sourceId);
    return { removed: true };
  }
}
