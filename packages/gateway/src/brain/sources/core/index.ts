/**
 * Company Brain sources service (spec 565): the shared sync runner, the kind registry, the /sources service and
 * routes, and the start step that bootstraps the github, matrix and connector tables and builds every kind handler.
 */
export { runBrainSourceSync } from "./runner.js";
export {
  BRAIN_CONNECTABLE_SOURCE_KINDS, BRAIN_SOURCE_ACCOUNT_SERVICES, BRAIN_SOURCE_ACCOUNTS_MAX, createBrainSourceKindRegistry,
  type BrainSourceAccounts, type BrainSourceKindRegistry,
} from "./registry.js";
export { BRAIN_SOURCES_SERVICE_LIMITS, createBrainSourcesService, type BrainSourcesCoreDeps } from "./service.js";
export { createBrainSourcesRoutes } from "./routes.js";
export { createBrainGitSourceSync, gitSyncToSourceView } from "./views.js";
export {
  BRAIN_SOURCE_TABLE_GROUPS, bootstrapBrainSourceTables, createBrainSourceHandlers, startBrainSourcesService,
  type BrainSourceHandlersDeps, type BrainSourcesStartDeps, type BrainSourceTableGroup,
} from "./start.js";
