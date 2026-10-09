/**
 * The Company Brain's gateway seams, kept out of server.ts (near its 2,000-line limit), which only mounts /api/brain,
 * starts the jobs and stops the brain in close(). server.ts extraction plan: GATEWAY_ROUTE_GROUPS (route-inventory.ts).
 */
import { createBrainAgentReadTools } from "../brain/agent/index.js";
import { createBrainAgentTools, createBrainProjectCleanup, resolveBrainAgentOwnerId } from "../brain/api/index.js";
import {
  createBrainLateBoundIntegrations, type BrainIntegrationCallerDeps,
} from "../brain/sources/integration/index.js";
import type { ProjectBrainCleanup } from "../project-deletion-cleanup.js";
import type { OwnerDatabaseServices } from "../startup/owner-database.js";

type BrainOwnerDatabase = Pick<OwnerDatabaseServices, "brainServices" | "brainService" | "kyselyInstance"> | null;

/**
 * The owner database (and the brain) starts before platform integrations: bindIntegrations binds them once they exist.
 * Only the gateway's owner may spend its credentials in the brain: MATRIX_BRAIN_GITHUB_TOKEN, the Anthropic key of
 * model claims and the OpenAI key of meaning search. Its principals: the configured ids and the one a request without
 * credentials resolves to (dev: "default", also beside a MATRIX_CLERK_USER_ID alone).
 */
export function createBrainGatewayStart(configuredOwnerIds: readonly string[], env: NodeJS.ProcessEnv = process.env) {
  const integrations = createBrainLateBoundIntegrations();
  const local = resolveBrainAgentOwnerId(env);
  const ownerIds = [...new Set([...configuredOwnerIds, ...(local === null ? [] : [local])])];
  const bindIntegrations = (deps: Omit<BrainIntegrationCallerDeps, "env">) => integrations.bind({ ...deps, env });
  return { integrations, ownerIds, bindIntegrations };
}

/**
 * brain_why and the read tools, bound to the owner (each undefined while its service or the owner is missing). The
 * dispatcher hands them only to a run whose server-set callerId is one of `ownerIds`: the owner's shell, canonical
 * Chat and /api/message runs, never a collaborator's, a shared or organization chat's, a channel's or a background one.
 */
export function createBrainGatewayAgentTools(services: BrainOwnerDatabase, ownerIds: readonly string[]) {
  const brain = services?.brainServices ?? null;
  return {
    brainTools: createBrainAgentTools(services?.brainService ?? null),
    brainReadTools: createBrainAgentReadTools({
      ownerId: resolveBrainAgentOwnerId(), project: brain?.project ?? null, search: brain?.search ?? null,
      graph: brain?.graph ?? null, brief: brain?.brief ?? null, impact: brain?.impact ?? null,
    }),
    brainOwnerIds: ownerIds,
  };
}

/**
 * A deferred or off brain still holds the project's rows: the erase runs on the owner database whatever the brain's
 * state, and a failed erase (or an owner database that is down) fails the deletion so it is retried.
 */
export function createBrainGatewayProjectErase(
  databaseConfigured: boolean, services: BrainOwnerDatabase,
): ProjectBrainCleanup {
  const erase = createBrainProjectCleanup({
    databaseConfigured, db: services?.kyselyInstance ?? null, services: services?.brainServices ?? null,
  });
  return (project, principal) => erase(principal.userId, project.id);
}
