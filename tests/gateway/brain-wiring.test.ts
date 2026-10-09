/**
 * The Company Brain composition boundary: startup builds every feature on the owner database, the gateway mounts
 * every route and hands the agent its tools, each feature folder exports its contract names, and every route of
 * BRAIN_ROUTES answers from a mounted handler, the /sources and /jobs routes included.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createBrainAgentReadTools } from "../../packages/gateway/src/brain/agent/index.js";
import {
  createBrainApiRoutes, startBrainServices, stopBrainServices, type BrainServicesHandle,
} from "../../packages/gateway/src/brain/api/index.js";
import { BRAIN_API_ERRORS, type BrainProjectLookup } from "../../packages/gateway/src/brain/api/types.js";
import {
  BRAIN_BOOTSTRAP_ORDER, BRAIN_FEATURE_ERRORS, BRAIN_FEATURE_EXPORTS, BRAIN_HOOK_REACTIONS, BRAIN_IMPACT_LIMITS,
  BRAIN_JOB_KINDS, BRAIN_ROUTE_ACCEPTED_PATHS, BRAIN_ROUTES, BRAIN_SEARCH_NOTICES, BRAIN_SNIPPET_FIELDS,
  BRAIN_SOURCE_NOTICES, type BrainGraphService, type BrainImpactView, type BrainRefreshView,
  type BrainSearchCapabilityView, type BrainSearchNotice, type BrainServices, type BrainSnippetView,
  type BrainSourceKindHandler, type BrainSourceNotice,
} from "../../packages/gateway/src/brain/contracts.js";
import { BRAIN_JOB_ERRORS, BRAIN_JOB_WORKER_NAME } from "../../packages/gateway/src/brain/jobs/index.js";
import { BRAIN_READ_IPC_TOOL_NAMES, brainReadIpcToolNames } from "../../packages/kernel/src/tools/brain-read-tools.js";
import {
  createBrainGatewayAgentTools, createBrainGatewayProjectErase, createBrainGatewayStart,
} from "../../packages/gateway/src/server/brain-wiring.js";
import type { ProjectConfig } from "../../packages/gateway/src/project-manager.js";
import {
  getOptionalRequestPrincipal, readPrincipalRuntimeConfig, type RequestPrincipal,
} from "../../packages/gateway/src/request-principal.js";
import { createBrainHarness, type BrainHarness } from "./helpers/brain-store-helpers.js";

/** No model claims: start never builds a client from the environment in these tests. */
const noModel = async () => null;
const read = (file: string) => readFileSync(join(process.cwd(), "packages/gateway/src", file), "utf8");

/** Contract names of the connectors feature that sources/core serves (the shared runner, service and routes). */
const SOURCES_CORE_NAMES = new Set(["runBrainSourceSync", "createBrainSourcesService", "createBrainSourcesRoutes"]);
const FEATURE_INDEXES: Record<keyof typeof BRAIN_FEATURE_EXPORTS, () => Promise<Record<string, unknown>>> = {
  search: () => import("../../packages/gateway/src/brain/search/index.js"),
  graph: () => import("../../packages/gateway/src/brain/graph/index.js"),
  github: () => import("../../packages/gateway/src/brain/sources/github/index.js"),
  matrix_sources: () => import("../../packages/gateway/src/brain/sources/matrix/index.js"),
  connectors: () => import("../../packages/gateway/src/brain/sources/connectors/index.js"),
  brief: () => import("../../packages/gateway/src/brain/brief/index.js"),
  impact: () => import("../../packages/gateway/src/brain/impact/index.js"),
  agent_tools: () => import("../../packages/gateway/src/brain/agent/index.js"),
  jobs: () => import("../../packages/gateway/src/brain/jobs/index.js"),
};

it("starts the brain with the owner database and hands it to the routes, the agent and shutdown", () => {
  // Composition boundary: the service, route and tool suites build their own instances and cannot see these lines.
  const startup = read("startup/owner-database.ts");
  const messaging = startup.indexOf("await messagingRepository.bootstrap();");
  const brain = startup.indexOf("services.brainServices = await startBrainServices(kysely");
  expect(messaging).toBeGreaterThan(0);
  expect(brain).toBeGreaterThan(messaging);
  expect(startup).toContain("services.brainService = services.brainServices?.project ?? null;");
  // The sources read the owner's notes, chats and integrations; the integrations are bound once they exist.
  const sources = startup.slice(brain, startup.indexOf("\n      });", brain));
  for (const part of [
    "notes: createBrainMatrixNotesReader(db), chats: chatRepository,", "integrations: brainIntegrations.caller,",
    "isConfigured: () => brainIntegrations.configured(),", "isConnected: brainIntegrations.isConnected,",
    "accounts: brainIntegrations.accounts,",
    "githubTokenOwnerIds: options.brainOwnerIds",
  ]) expect(sources, part).toContain(part);
  // The same owner principals hold the model and embeddings keys.
  expect(startup.slice(brain, brain + 400)).toContain("...(options.brainOwnerIds ? { ownerIds: options.brainOwnerIds } : {}),");

  const server = read("server.ts");
  const services = server.indexOf("const ownerDatabaseServices = ownerDatabaseStartup.services;");
  const dispatcher = server.indexOf("createDispatcher({", services);
  const tools = server.indexOf("...createBrainGatewayAgentTools(ownerDatabaseServices),", dispatcher);
  const dispatcherEnd = server.indexOf("\n  });", dispatcher);
  const auth = server.indexOf('app.use("*", authMiddleware(');
  const routes = server.indexOf('app.route("/api/brain", createBrainApiRoutes(ownerDatabaseServices?.brainServices ?? null, '
    + "(c) => requireRequestPrincipal(c)));");
  const serve = server.indexOf("const server = serve({");
  const jobs = server.indexOf("for (const job of ownerDatabaseServices?.brainServices?.jobs ?? []) job.start();");
  const close = server.indexOf("async close() {");
  const stop = server.indexOf("await stopBrainServices(ownerDatabaseServices?.brainServices ?? null);", close);
  const late = server.indexOf("const brainStart = createBrainGatewayStart(codingAgentOwnerIds);");
  const startOwner = server.indexOf("await initializeOwnerDatabaseServices({");
  const passed = server.indexOf(
    "brainIntegrations: brainStart.integrations, brainOwnerIds: brainStart.ownerIds,", startOwner,
  );
  const pipedream = server.indexOf("const pipedreamClient = platformIntegrations.client;");
  const bind = server.indexOf("brainStart.bindIntegrations({\n    internalBaseUrl: internalIntegrationBaseUrl, "
    + "machineToken: internalPlatformToken, db: platformDb, pipedream: pipedreamClient,\n  });");
  for (const position of [late, startOwner, passed, pipedream, bind]) expect(position).toBeGreaterThan(0);
  expect(late).toBeLessThan(startOwner);
  expect(passed - startOwner).toBeLessThan(120);
  expect(bind).toBeGreaterThan(pipedream);
  for (const position of [services, dispatcher, tools, auth, serve, close]) expect(position).toBeGreaterThan(0);
  expect(tools).toBeLessThan(dispatcherEnd);
  expect(routes).toBeGreaterThan(auth);
  expect(jobs).toBeGreaterThan(serve);
  // Jobs and hooks stop first, before anything closes the owner database.
  expect(stop - close).toBeLessThan(80);
  // The seams live in server/brain-wiring.ts: server.ts only calls them.
  for (const name of ["createBrainLateBoundIntegrations", "createBrainAgentReadTools", "createBrainProjectCleanup"]) {
    expect(server, name).not.toContain(name);
  }
});

describe("gateway seams (server/brain-wiring.ts)", () => {
  it("lets only the configured owner spend the brain's credentials, and \"default\" outside production", () => {
    expect(createBrainGatewayStart(["user_a"], { NODE_ENV: "production" }).ownerIds).toEqual(["user_a"]);
    expect(createBrainGatewayStart([], { NODE_ENV: "production" }).ownerIds).toEqual([]);
    expect(createBrainGatewayStart([], { NODE_ENV: "development" }).ownerIds).toEqual(["default"]);
    const start = createBrainGatewayStart([], {});
    start.bindIntegrations({});
    expect(() => start.bindIntegrations({})).toThrow("Brain integrations are already bound");
  });

  it("adds the principal a local request resolves to, as with only MATRIX_CLERK_USER_ID set in dev", () => {
    const clerkOnly = { NODE_ENV: "development", MATRIX_CLERK_USER_ID: "user_c" };
    const local = getOptionalRequestPrincipal({ get: () => undefined }, {
      ...readPrincipalRuntimeConfig(clerkOnly), requireAuthContextReady: false,
    });
    expect(local?.userId).toBe("default");
    expect(createBrainGatewayStart(["user_c"], clerkOnly).ownerIds).toEqual(["user_c", "default"]);
    for (const env of [{ MATRIX_AUTH_TOKEN: "t" }, { MATRIX_USER_ID: "user_c" }, { NODE_ENV: "production" }]) {
      expect(createBrainGatewayStart(["user_c"], { ...clerkOnly, ...env }).ownerIds).toEqual(["user_c"]);
    }
  });

  it("offers no agent tools while the brain is off", () => {
    expect(createBrainGatewayAgentTools(null)).toEqual({ brainTools: undefined, brainReadTools: undefined });
  });

  it("erases a deleted project through the brain, and fails the deletion when the database is down", async () => {
    const eraseProject = vi.fn(async () => undefined);
    const brainServices = { eraseProject } as unknown as BrainServicesHandle;
    const project = { id: "proj_a" } as ProjectConfig;
    const principal = { userId: "owner_a" } as RequestPrincipal;
    const services = { brainServices, brainService: null, kyselyInstance: null };
    await createBrainGatewayProjectErase(true, services)(project, principal);
    expect(eraseProject).toHaveBeenCalledWith("owner_a", "proj_a");
    await expect(createBrainGatewayProjectErase(true, null)(project, principal)).rejects.toThrow("cleanup unavailable");
    await expect(createBrainGatewayProjectErase(false, null)(project, principal)).resolves.toBeUndefined();
  });
});

describe("contract vocabularies", () => {
  it("routes documents_changed to the brief listener too, after search and graph", () => {
    expect(BRAIN_HOOK_REACTIONS.documents_changed).toEqual(["search", "graph", "brief"]);
    expect(BRAIN_BOOTSTRAP_ORDER).toEqual([
      "core", "search", "graph", "github", "matrix_sources", "connectors", "brief", "jobs",
    ]);
  });

  it("lists the background run routes, kinds and codes the jobs folder serves", () => {
    const jobs = BRAIN_ROUTES.filter((route) => route.owner === "jobs").map((route) => `${route.method} ${route.path}`);
    expect(jobs).toEqual([
      "POST /projects/:projectId/jobs", "GET /projects/:projectId/jobs", "GET /projects/:projectId/jobs/:jobId",
      "POST /projects/:projectId/jobs/:jobId/cancel",
    ]);
    expect(BRAIN_ROUTE_ACCEPTED_PATHS).toEqual(["/projects/:projectId/jobs"]);
    expect(BRAIN_JOB_KINDS).toEqual(["sync", "extract", "search_refresh", "graph_refresh", "brief"]);
    // One table of client text: the jobs routes answer the shared feature codes.
    expect(BRAIN_JOB_ERRORS).toEqual({
      job_not_found: BRAIN_FEATURE_ERRORS.job_not_found, job_kind_unavailable: BRAIN_FEATURE_ERRORS.job_kind_unavailable,
      jobs_full: BRAIN_FEATURE_ERRORS.jobs_full,
    });
    expect(BRAIN_FEATURE_ERRORS.job_not_found).toEqual({ status: 404, message: "Run not found" });
    expect(BRAIN_JOB_WORKER_NAME).toBe("brain-jobs");
  });

  it("types merge suggestions, the vector store, refresh spend and impact totals in the contract", () => {
    // Typed: each line fails the typecheck without its contract change.
    const method: keyof BrainGraphService = "mergeSuggestions";
    const capability: BrainSearchCapabilityView = {
      fullText: true, vector: "available", providerId: "openai/text-embedding-3-small/256", store: "array",
    };
    const refresh: BrainRefreshView = {
      index: "search", processed: 1, removed: 0, caughtUp: true,
      freshness: { caughtUp: true, pendingDocuments: 0, pendingCapped: false },
      embedding: { tokens: 10, costMicroUsd: 1, stopped: "budget" },
    };
    const totals: BrainImpactView["dependentTotals"] = { depth1: 3, depth2: null };
    expect([method, capability.store, refresh.embedding?.stopped, totals.depth2]).toEqual([
      "mergeSuggestions", "array", "budget", null,
    ]);
    expect(BRAIN_IMPACT_LIMITS.depthDefault).toBe(2);
  });

  it("names the any-term fallback, label snippets, skipped secrets and the connect pre-check", async () => {
    // Typed: each line fails the typecheck without its contract change, and the lists fail the run.
    const notice: BrainSearchNotice = "any_term_fallback";
    const field: BrainSnippetView["field"] = "label";
    const skipped: BrainSourceNotice = "secret_skipped";
    expect(BRAIN_SEARCH_NOTICES).toContain(notice);
    expect(BRAIN_SNIPPET_FIELDS).toContain(field);
    expect(BRAIN_SOURCE_NOTICES).toContain(skipped);
    const checked: Pick<BrainSourceKindHandler<{ readonly repo: string }>, "kind" | "parseConfig" | "checkConfig"> = {
      kind: "github", parseConfig: () => ({ repo: "a/b" }), checkConfig: async () => undefined,
    };
    await expect(checked.checkConfig!({ ownerId: "o", scopeId: "s" }, { repo: "a/b" })).resolves.toBeUndefined();
  });
});

describe("feature exports", () => {
  for (const [feature, names] of Object.entries(BRAIN_FEATURE_EXPORTS)) {
    it(`${feature} exports its contract names`, async () => {
      const module = await FEATURE_INDEXES[feature as keyof typeof FEATURE_INDEXES]();
      const core: Record<string, unknown> = await import("../../packages/gateway/src/brain/sources/core/index.js");
      for (const name of names) {
        expect(typeof (SOURCES_CORE_NAMES.has(name) ? core : module)[name], `${feature}.${name}`).toBe("function");
      }
    });
  }
});

describe("mounted routes", { timeout: 60_000 }, () => {
  let harness: BrainHarness;
  let services: BrainServices | null = null;
  let app: Hono;
  const principal = () => ({ userId: "owner_a", source: "dev-default" });
  const known = new Set<string>([...Object.keys(BRAIN_API_ERRORS), ...Object.keys(BRAIN_FEATURE_ERRORS)]);
  const missing = async () => ({ ok: false as const, status: 404, error: { code: "not_found", message: "Project was not found" } });
  const projects: BrainProjectLookup = {
    getProjectById: vi.fn(missing), getProject: vi.fn(missing), resolveProjectWorkingDirectory: vi.fn(async () => null),
  };

  beforeAll(async () => {
    harness = await createBrainHarness();
    services = await startBrainServices(harness.db, { projects, homePath: "/home", claimModels: noModel, scheduleOwnerId: null });
    app = createBrainApiRoutes(services, principal as never);
  });
  afterAll(async () => {
    await stopBrainServices(services, 1_000);
    await harness.destroy();
  });

  function request(route: (typeof BRAIN_ROUTES)[number], root: Hono) {
    const path = route.path.replace(":projectId", "proj_missing").replace(":entityId", `ent_${"a".repeat(32)}`)
      .replace(":sourceId", `src_${"b".repeat(32)}`).replace(":jobId", `job_${"c".repeat(32)}`);
    const body = route.bodyMaxBytes === null ? {} : { body: "{}", headers: { "content-type": "application/json" } };
    return root.request(path, { method: route.method, ...body });
  }

  it("answers every route from a handler with a known error code and no-store", async () => {
    for (const route of BRAIN_ROUTES) {
      const response = await request(route, app);
      const text = await response.text();
      const label = `${route.method} ${route.path}`;
      const code = (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "";
      expect(known.has(code), `${label} answered ${response.status} ${code}`).toBe(true);
      expect(response.headers.get("cache-control"), label).toBe("private, no-store");
      expect(response.status, label).toBeLessThan(500);
    }
  });

  it("lists every mounted route in BRAIN_ROUTES, so the inventory never misses one", () => {
    const listed = new Set(BRAIN_ROUTES.map((route) => `${route.method} ${route.path}`));
    const mounted = new Set(app.routes.filter((route) => route.method !== "ALL")
      .map((route) => `${route.method} ${route.path}`));
    expect(mounted.size).toBeGreaterThanOrEqual(BRAIN_ROUTES.length);
    expect([...mounted].filter((route) => !listed.has(route))).toEqual([]);
    expect(mounted).toContain("GET /projects/:projectId/entities/merge-suggestions");
    for (const route of ["POST /projects/:projectId/jobs", "GET /projects/:projectId/jobs/:jobId"]) {
      expect(mounted).toContain(route);
    }
  });

  it("builds the run service and its worker with the other services", () => {
    expect(services?.runs).not.toBeNull();
    // scheduleOwnerId is null here: no worker, so nothing would run a queued job.
    expect(services?.jobs.map((job) => job.name)).not.toContain("brain-jobs");
  });

  it("answers 503 brain_unavailable on every mounted route while the brain is off", async () => {
    const off = createBrainApiRoutes(null, principal as never);
    for (const route of BRAIN_ROUTES) {
      const response = await request(route, off);
      expect({ route: route.path, status: response.status, body: await response.json() }).toMatchObject({
        status: 503, body: { error: { code: "brain_unavailable" } },
      });
    }
  });

  it("gives the agent every read tool once all services exist", () => {
    const tools = createBrainAgentReadTools({
      ownerId: "owner_a", project: services!.project, search: services!.search, graph: services!.graph,
      brief: services!.brief, impact: services!.impact,
    });
    expect(Object.keys(tools ?? {}).sort()).toEqual(["brief", "claims", "conflicts", "impact", "search", "timeline"]);
    expect(brainReadIpcToolNames(tools)).toEqual([...BRAIN_READ_IPC_TOOL_NAMES]);
  });
});
