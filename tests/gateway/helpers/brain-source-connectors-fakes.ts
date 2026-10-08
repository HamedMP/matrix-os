/**
 * Fakes for the connector source tests: a scripted integration caller, a recording hooks bus, a PGlite harness with
 * the connector table and one source of a kind, and the project every handler call uses. No network.
 */
import type {
  BrainChangeEvent, BrainChangeHooks, BrainIntegrationCallOutcome, BrainIntegrationCallRequest, BrainIntegrationCaller,
  BrainResolvedProject, BrainSourceAdapter, BrainSourceKindHandler, BrainSourceSyncLimits, BrainSourceSyncResult,
} from "../../../packages/gateway/src/brain/contracts.js";
import {
  bootstrapBrainConnectorDatabase, runBrainSourceSync,
} from "../../../packages/gateway/src/brain/sources/connectors/index.js";
import type { BrainScopeKey } from "../../../packages/gateway/src/brain/types.js";
import { createBrainHarness, type BrainHarness, type BrainHarnessOptions } from "./brain-store-helpers.js";

export const connectorScope: BrainScopeKey = { ownerId: "owner_a", scopeId: "personal:project:proj_a" };
export const connectorProject: BrainResolvedProject = {
  projectId: "proj_a", slug: "alpha", name: "Alpha", scope: connectorScope,
};

export type FakeRoute = (
  params: Readonly<Record<string, unknown>>, signal: AbortSignal, request: BrainIntegrationCallRequest,
) => BrainIntegrationCallOutcome | Promise<BrainIntegrationCallOutcome>;

export interface FakeIntegrations extends BrainIntegrationCaller {
  readonly calls: { ownerId: string; service: string; action: string; params: Readonly<Record<string, unknown>>; label?: string }[];
}

/** Routes by "service.action"; an unknown action answers unavailable. */
export function fakeIntegrations(routes: Record<string, FakeRoute>): FakeIntegrations {
  const calls: FakeIntegrations["calls"] = [];
  return {
    calls,
    async call(ownerId, request, signal) {
      calls.push({ ownerId, service: request.service, action: request.action, params: request.params,
        ...(request.label === undefined ? {} : { label: request.label }) });
      const route = routes[`${request.service}.${request.action}`];
      return route === undefined ? { status: "unavailable" } : route(request.params, signal, request);
    },
  };
}

export const ok = (data: unknown): BrainIntegrationCallOutcome => ({ status: "ok", data });

export function recordingHooks(): BrainChangeHooks & { readonly events: BrainChangeEvent[] } {
  const events: BrainChangeEvent[] = [];
  return { events, emit: (event) => { events.push(event); }, close: async () => undefined };
}

export interface ConnectorHarness extends BrainHarness {
  readonly sourceId: string;
  readonly externalRef: string;
  /** One run of the shared runner against this source. */
  sync<TConfig>(adapter: BrainSourceAdapter<TConfig>, config: TConfig, extra?: Partial<Parameters<typeof runBrainSourceSync>[0]>):
    Promise<BrainSourceSyncResult>;
  /** One run of a fresh adapter from `handler` for owner_a. */
  run<TConfig>(handler: BrainSourceKindHandler<TConfig>, config: TConfig, limits?: Partial<BrainSourceSyncLimits>):
    Promise<BrainSourceSyncResult>;
  liveIds(): Promise<string[]>;
}

export async function connectorHarness(
  kind: string, externalRef = `${kind}:test`, options: BrainHarnessOptions = {},
): Promise<ConnectorHarness> {
  const harness = await createBrainHarness(options);
  await bootstrapBrainConnectorDatabase(harness.db);
  const { source } = await harness.repository.createSource(connectorScope, { kind, externalRef, label: kind });
  const sync: ConnectorHarness["sync"] = (adapter, config, extra = {}) => runBrainSourceSync({
    repository: harness.repository, scope: connectorScope, sourceId: source.sourceId, adapter, config,
    now: () => harness.now().getTime(), ...extra,
  });
  return {
    ...harness, sourceId: source.sourceId, externalRef, sync,
    async run(handler, config, limits = {}) {
      const created = await handler.createAdapter("owner_a", connectorProject, config);
      if (!created.ok) throw new Error(created.code);
      return sync(created.adapter, config, { limits });
    },
    async liveIds() {
      const page = await harness.repository.listDocuments(connectorScope, { sourceId: source.sourceId, limit: 100 });
      return page.items.map((item) => item.documentId).sort();
    },
  };
}
