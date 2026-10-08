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
  createBrainApiRoutes, startBrainServices, stopBrainServices,
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
  const tools = server.indexOf("brainTools: createBrainAgentTools(ownerDatabaseServices?.brainService ?? null),", dispatcher);
  const readTools = server.indexOf("brainReadTools: createBrainAgentReadTools({", dispatcher);
  const dispatcherEnd = server.indexOf("\n  });", dispatcher);
  const auth = server.indexOf('app.use("*", authMiddleware(');
  const routes = server.indexOf('app.route("/api/brain", createBrainApiRoutes(ownerDatabaseServices?.brainServices ?? null, '
    + "(c) => requireRequestPrincipal(c)));");
  const serve = server.indexOf("const server = serve({");
  const jobs = server.indexOf("for (const job of ownerDatabaseServices?.brainServices?.jobs ?? []) job.start();");
  const close = server.indexOf("async close() {");
  const stop = server.indexOf("await stopBrainServices(ownerDatabaseServices?.brainServices ?? null);", close);
  const late = server.indexOf("const brainIntegrations = createBrainLateBoundIntegrations();");
  const startOwner = server.indexOf("await initializeOwnerDatabaseServices({");
  const passed = server.indexOf("    brainIntegrations,\n    brainOwnerIds,\n", startOwner);
  const pipedream = server.indexOf("const pipedreamClient = platformIntegrations.client;");
  const bind = server.indexOf("brainIntegrations.bind({\n    internalBaseUrl: internalIntegrationBaseUrl, "
    + "machineToken: internalPlatformToken, db: platformDb, pipedream: pipedreamClient,\n    env: process.env,\n  });");
  for (const position of [late, startOwner, passed, pipedream, bind]) expect(position).toBeGreaterThan(0);
  expect(late).toBeLessThan(startOwner);
  expect(passed - startOwner).toBeLessThan(120);
  expect(bind).toBeGreaterThan(pipedream);
  for (const position of [services, dispatcher, tools, readTools, auth, serve, close]) expect(position).toBeGreaterThan(0);
  expect(Math.max(tools, readTools)).toBeLessThan(dispatcherEnd);
  expect(routes).toBeGreaterThan(auth);
  expect(jobs).toBeGreaterThan(serve);
  // Jobs and hooks stop first, before anything closes the owner database.
  expect(stop - close).toBeLessThan(80);
});
