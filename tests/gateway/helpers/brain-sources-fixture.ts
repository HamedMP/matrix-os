/**
 * Fixtures for the sources service tests: a PGlite brain with the github, matrix and connector tables, a project
 * resolver fake, a recording hooks bus, and a scripted kind handler whose configs live in memory and whose adapter
 * writes one document per item. No network.
 */
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BrainApiError } from "../../../packages/gateway/src/brain/api/types.js";
import {
  BRAIN_SOURCE_KIND_PROVENANCES, BrainFeatureError, type BrainAnySourceKindHandler, type BrainConnectableSourceKind,
  type BrainProjectResolver,
  type BrainResolvedProject, type BrainSourceAdapter, type BrainSourceAdapterResolution, type BrainSourceKindAvailability,
  type BrainSourceOptionsView,
} from "../../../packages/gateway/src/brain/contracts.js";
import type { BrainScopeKey } from "../../../packages/gateway/src/brain/index.js";
import { bootstrapBrainSourceTables } from "../../../packages/gateway/src/brain/sources/core/index.js";
import { recordingHooks } from "./brain-source-connectors-fakes.js";
import { createBrainHarness, type BrainHarness } from "./brain-store-helpers.js";

export { recordingHooks };

export const OWNER = "owner_a";
export const SCOPE_A: BrainScopeKey = { ownerId: OWNER, scopeId: "personal:project:proj_a" };
export const SCOPE_B: BrainScopeKey = { ownerId: OWNER, scopeId: "personal:project:proj_b" };
export const PROJECT_A: BrainResolvedProject = { projectId: "proj_a", slug: "alpha", name: "Alpha", scope: SCOPE_A };
export const PROJECT_B: BrainResolvedProject = { projectId: "proj_b", slug: "beta", name: "Beta", scope: SCOPE_B };
const PROJECT_C: BrainResolvedProject = {
  projectId: "proj_c", slug: "gamma", name: "Gamma", scope: { ownerId: "owner_b", scopeId: "personal:project:proj_c" },
};

/** owner_a has proj_a (also "alpha") and proj_b; owner_b has proj_c; everything else is project_not_found. */
export function sourcesResolver(homePath = "/home"): BrainProjectResolver {
  const projects: Record<string, BrainResolvedProject> = {
    "owner_a/proj_a": PROJECT_A, "owner_a/alpha": PROJECT_A, "owner_a/proj_b": PROJECT_B, "owner_b/proj_c": PROJECT_C,
  };
  return {
    homePath,
    async resolve(ownerId, projectRef) {
      const project = projects[`${ownerId}/${projectRef}`];
      if (project === undefined) throw new BrainApiError("project_not_found");
      return project;
    },
    checkoutPath: async () => null,
  };
}

export interface SourcesHarness extends BrainHarness {
  readonly resolver: BrainProjectResolver;
  readonly hooks: ReturnType<typeof recordingHooks>;
  liveSources(scope?: BrainScopeKey): Promise<{ sourceId: string; kind: string; externalRef: string }[]>;
}

export async function sourcesHarness(): Promise<SourcesHarness> {
  const harness = await createBrainHarness();
  const ready = await bootstrapBrainSourceTables(harness.db);
  if (ready.length !== 3) throw new Error("source tables missing");
  return {
    ...harness, resolver: sourcesResolver(), hooks: recordingHooks(),
    async liveSources(scope = SCOPE_A) {
      const page = await harness.repository.listSources(scope, { limit: 100 });
      return page.items.map(({ sourceId, kind, externalRef }) => ({ sourceId, kind, externalRef }));
    },
  };
}

/** The scripted config: items name the source; a flag and an optional account are options. */
export interface FakeConfig {
  readonly items: readonly string[]; readonly accountLabel?: string; readonly includeEventBodies?: boolean;
  readonly mode?: "integration" | "token";
}
const FakeConfigSchema = z.object({
  items: z.array(z.string().regex(/^[a-z0-9]{1,16}$/)).min(1).max(5),
  accountLabel: z.string().min(1).max(40).optional(), includeEventBodies: z.boolean().optional(),
  mode: z.enum(["integration", "token"]).optional(),
}).strict();

export interface FakeHandlerOptions {
  readonly availability?: () => Promise<BrainSourceKindAvailability>;
  readonly checkConfig?: (config: FakeConfig) => Promise<void>;
  readonly saveConfig?: (config: FakeConfig) => Promise<void>;
  readonly adapter?: () => Promise<BrainSourceAdapterResolution<FakeConfig>>;
  readonly listOptions?: () => Promise<BrainSourceOptionsView>;
  /** Stored config rows read back as this (for a row the schema now refuses). */
  readonly refuseStored?: boolean;
  /** Every config read fails with this (a store outage). */
  readonly loadError?: Error;
}

export interface FakeHandler extends BrainAnySourceKindHandler {
  readonly calls: string[];
  readonly configs: Map<string, FakeConfig>;
}

export function fakeDocumentId(externalRef: string, item: string): string {
  return createHash("sha256").update(JSON.stringify(["fake_v1", externalRef, item])).digest("hex");
}

/** One page writing one document per config item, caught up. */
export function fakeAdapter(kind: BrainConnectableSourceKind): BrainSourceAdapter<FakeConfig> {
  return {
    kind,
    async readPage(context) {
      const upserts = context.config.items.map((item) => ({
        documentId: fakeDocumentId(context.externalRef, item), title: `Item ${item}`, body: `Body of ${item}`,
        permalink: "", sourceUpdatedAt: "2026-10-01T09:00:00.000Z", provenance: BRAIN_SOURCE_KIND_PROVENANCES[kind][0]!,
      }));
      return { ok: true, page: { upserts, deletions: [], nextCursor: "fake:1", caughtUp: true, skipped: 0, notices: [] } };
    },
  };
}

export function fakeHandler(kind: BrainConnectableSourceKind, options: FakeHandlerOptions = {}): FakeHandler {
  const calls: string[] = [];
  const configs = new Map<string, FakeConfig>();
  const key = (scope: BrainScopeKey, sourceId: string) => `${scope.ownerId}/${scope.scopeId}/${sourceId}`;
  const handler: FakeHandler = {
    kind, calls, configs,
    parseConfig(raw) {
      calls.push("parse");
      const parsed = FakeConfigSchema.safeParse(raw);
      if (!parsed.success) throw new BrainFeatureError("source_config_invalid", { cause: parsed.error });
      return parsed.data;
    },
    identify(_project, config) {
      calls.push("identify");
      const fake = config as FakeConfig;
      return { externalRef: `${kind}:${[...fake.items].sort().join(",")}:${fake.accountLabel ?? ""}`, label: `Fake ${fake.items.join(", ")}` };
    },
    async checkConfig(_scope, config) {
      calls.push("check");
      await options.checkConfig?.(config as FakeConfig);
    },
    async saveConfig(scope, sourceId, config) {
      calls.push("save");
      await options.saveConfig?.(config as FakeConfig);
      configs.set(key(scope, sourceId), config as FakeConfig);
    },
    async loadConfig(scope, sourceId) {
      calls.push("load");
      if (options.loadError !== undefined) throw options.loadError;
      const stored = configs.get(key(scope, sourceId)) ?? null;
      if (stored !== null && options.refuseStored === true) throw new BrainFeatureError("source_config_invalid");
      return stored;
    },
    async createAdapter() {
      calls.push("adapter");
      return options.adapter === undefined ? { ok: true, adapter: fakeAdapter(kind) } : options.adapter();
    },
    viewConfig: (config) => {
      const fake = config as FakeConfig;
      return { items: [...fake.items], accountLabel: fake.accountLabel ?? null };
    },
    availability: options.availability ?? (async () => ({ available: true })),
    ...(options.listOptions === undefined ? {} : {
      listOptions: async () => options.listOptions!(),
    }),
  };
  return handler;
}

/** A promise and its resolver, for holding a call until the test lets it go. */
export function gate(): { readonly wait: Promise<void>; open(): void } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => { open = resolve; });
  return { wait, open: () => open() };
}
