/**
 * Company Brain project API surface: the owner-scoped service, the shared project resolver, the /api/brain routes,
 * the brain_why agent tool adapter, and the start of every feature (start.ts). brain/index.ts does not re-export
 * this folder (it would create an import cycle through git/).
 */
export { createBrainProjectService, startBrainProjectService } from "./service.js";
export { createBrainProjectResolver, lookupBrainProject } from "./project-resolver.js";
export { createBrainRoutes, type BrainRoutesDeps } from "./routes.js";
export { createBrainApiRoutes } from "./feature-routes.js";
export {
  startBrainServices, stopBrainServices, withBrainChangeEvents, type BrainServicesHandle, type BrainServicesStartDeps,
  type BrainSourcesStartOptions,
} from "./start.js";
export { createBrainProjectCleanup, eraseBrainProject, eraseBrainScopeRows } from "./erase.js";
export {
  BRAIN_INDEX_CATCH_UP, BRAIN_SOURCE_PURGE, createBrainIndexCatchUp, listBrainSourceScopes, purgeBrainRemovedSource,
  runBrainIndexCatchUp,
} from "./index-repair.js";
export { createBrainAgentTools, resolveBrainAgentOwnerId } from "./agent-tools.js";
export * from "./types.js";
export * from "./claims-types.js";
