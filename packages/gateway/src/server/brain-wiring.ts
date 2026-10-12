/**
 * The Company Brain's gateway seams, kept out of server.ts (see its extraction plan), which only calls them, mounts
 * /api/brain, starts the jobs and stops the brain in close().
 */
import type { KernelConfig } from "@matrix-os/kernel";
import { createBrainAgentReadTools } from "../brain/agent/index.js";
import { createBrainAgentTools, createBrainProjectCleanup, resolveBrainAgentOwnerId } from "../brain/api/index.js";
import {
  createBrainLateBoundIntegrations, type BrainIntegrationCallerDeps,
} from "../brain/sources/integration/index.js";
import type { ProjectBrainCleanup } from "../project-deletion-cleanup.js";
import type { OwnerDatabaseServices } from "../startup/owner-database.js";

type BrainOwnerDatabase = Pick<OwnerDatabaseServices, "brainServices" | "brainService" | "kyselyInstance"> | null;
type BrainRunTools = Pick<KernelConfig, "brainTools" | "brainReadTools">;

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
 * brain_why and the read tools of one run, bound to its server-set callerId (each undefined while its service is
 * missing): only a caller in `ownerIds` gets them (the owner's shell, canonical Chat and /api/message runs), never a
 * collaborator, a shared or organization chat, a channel or a background run, which the dispatcher never asks for.
 */
export function createBrainGatewayAgentTools(services: BrainOwnerDatabase, ownerIds: readonly string[]) {
  const brain = services?.brainServices ?? null, owners = new Set(ownerIds);
  return {
    brainToolsFor: (callerId: string): BrainRunTools | undefined => (owners.has(callerId) ? {
      brainTools: createBrainAgentTools(services?.brainService ?? null, callerId),
      brainReadTools: createBrainAgentReadTools({
        ownerId: callerId, project: brain?.project ?? null, search: brain?.search ?? null,
        graph: brain?.graph ?? null, brief: brain?.brief ?? null, impact: brain?.impact ?? null,
      }),
    } : undefined),
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
