/**
 * Starting the sources service on the owner database: the github, matrix and connector tables are each bootstrapped
 * on their own (a failure is logged by error name and SQLSTATE and leaves only those kinds off: their handlers are
 * not registered and the kinds read not_configured), then one handler per kind whose tables exist, then the service
 * over the shared runner. Never throws for a table bootstrap; a missing core table still fails the service's calls.
 */
import type { Kysely } from "kysely";
import type {
  BrainAnySourceKindHandler, BrainChangeHooks, BrainFeatureBootstrap, BrainIntegrationCaller, BrainIntegrationService,
  BrainProjectResolver, BrainSourcesService, BrainSourcesServiceDeps, BrainSourceSyncLimits, BrainSourceSyncRunner,
} from "../../contracts.js";
import type { BrainRepository } from "../../repository.js";
import type { BrainDatabase } from "../../types.js";
import {
  bootstrapBrainConnectorDatabase, createBrainGoogleCalendarHandler, createBrainGoogleDriveHandler,
  createBrainLinearHandler, createBrainSlackBridgeHandler, type BrainSlackCaptureReader,
} from "../connectors/index.js";
import { bootstrapBrainGithubDatabase, createBrainGithubSourceHandler } from "../github/index.js";
import {
  bootstrapBrainMatrixDatabase, createBrainMatrixChatHandler, createBrainMatrixFilesHandler,
  createBrainMatrixNotesHandler, type BrainMatrixChatReader, type BrainMatrixNotesReader,
} from "../matrix/index.js";
import type { BrainSourceAccounts } from "./registry.js";
import { runBrainSourceSync } from "./runner.js";
import { createBrainSourcesService } from "./service.js";

/** The three source table groups, bootstrapped in BRAIN_BOOTSTRAP_ORDER. */
export const BRAIN_SOURCE_TABLE_GROUPS = ["github", "matrix_sources", "connectors"] as const;
export type BrainSourceTableGroup = (typeof BRAIN_SOURCE_TABLE_GROUPS)[number];

const DEFAULT_BOOTSTRAPS: Readonly<Record<BrainSourceTableGroup, BrainFeatureBootstrap>> = {
  github: bootstrapBrainGithubDatabase, matrix_sources: bootstrapBrainMatrixDatabase,
  connectors: bootstrapBrainConnectorDatabase,
};

export interface BrainSourceHandlersDeps {
  readonly kysely: Kysely<BrainDatabase>;
  readonly integrations: BrainIntegrationCaller;
  /** Whether an integration transport is bound; false: the integration kinds read not_configured. */
  readonly isConfigured?: () => boolean;
  /** Whether the owner has an account of a service; absent: the integration kinds read not_configured. */
  readonly isConnected?: (ownerId: string, service: BrainIntegrationService) => Promise<boolean>;
  /** The owner's account labels of a service; present: connects pin one and runs use only that one. */
  readonly accounts?: BrainSourceAccounts;
  /** The Matrix home for file sources; "" turns matrix_files off. */
  readonly homePath: string;
  /** The owner's Notes reader; null turns matrix_notes off. */
  readonly notes: BrainMatrixNotesReader | null;
  /** The owner's ChatRepository; null turns matrix_chat off. */
  readonly chats: BrainMatrixChatReader | null;
  /** Company Brain capture; absent turns slack_bridge off (not_configured). */
  readonly capture?: BrainSlackCaptureReader;
  /** Principals that may use MATRIX_BRAIN_GITHUB_TOKEN (the gateway's owner); absent: nobody. */
  readonly githubTokenOwnerIds?: readonly string[];
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}

export interface BrainSourcesStartDeps extends BrainSourceHandlersDeps {
  readonly repository: BrainRepository;
  readonly resolver: BrainProjectResolver;
  readonly hooks?: BrainChangeHooks;
  readonly gitSync?: BrainSourcesServiceDeps["gitSync"];
  readonly limits?: Partial<BrainSourceSyncLimits>;
  /** Test seams. */
  readonly runner?: BrainSourceSyncRunner;
  readonly bootstraps?: Partial<Record<BrainSourceTableGroup, BrainFeatureBootstrap>>;
}

function sqlState(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
  return typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : "";
}

/** Each group on its own, in order; returns the groups whose tables are ready. Never throws. */
export async function bootstrapBrainSourceTables(
  kysely: Kysely<BrainDatabase>, bootstraps: Partial<Record<BrainSourceTableGroup, BrainFeatureBootstrap>> = {},
): Promise<readonly BrainSourceTableGroup[]> {
  const ready: BrainSourceTableGroup[] = [];
  for (const group of BRAIN_SOURCE_TABLE_GROUPS) {
    try {
      await (bootstraps[group] ?? DEFAULT_BOOTSTRAPS[group])(kysely);
      ready.push(group);
    } catch (error: unknown) {
      console.error(`[brain-sources] ${group} sources are off after their tables failed:`,
        error instanceof Error ? error.name : typeof error, sqlState(error));
    }
  }
  return ready;
}

/** One handler per kind whose table group is ready. */
export function createBrainSourceHandlers(
  deps: BrainSourceHandlersDeps, ready: readonly BrainSourceTableGroup[],
): BrainAnySourceKindHandler[] {
  const { kysely, integrations } = deps;
  const configured = deps.isConfigured === undefined ? {} : { isConfigured: deps.isConfigured };
  const connection = {
    ...configured,
    ...(deps.isConnected === undefined ? {} : { isConnected: deps.isConnected }),
    ...(deps.accounts === undefined ? {} : { accounts: deps.accounts }),
  };
  const handlers: BrainAnySourceKindHandler[] = [];
  if (ready.includes("github")) {
    handlers.push(createBrainGithubSourceHandler({
      kysely, integrations, ...configured, ...(deps.isConnected === undefined ? {} : { isConnected: deps.isConnected }),
      ...(deps.githubTokenOwnerIds === undefined ? {} : { tokenOwnerIds: deps.githubTokenOwnerIds }),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), ...(deps.env === undefined ? {} : { env: deps.env }),
    }));
  }
  if (ready.includes("matrix_sources")) {
    handlers.push(
      createBrainMatrixNotesHandler({ kysely, notes: deps.notes }),
      createBrainMatrixFilesHandler({ kysely, homePath: deps.homePath }),
      createBrainMatrixChatHandler({ kysely, chats: deps.chats }),
    );
  }
  if (ready.includes("connectors")) {
    handlers.push(
      createBrainLinearHandler({ kysely, integrations, ...connection }),
      createBrainGoogleDriveHandler({ kysely, integrations, ...connection }),
      createBrainGoogleCalendarHandler({ kysely, integrations, ...connection }),
      createBrainSlackBridgeHandler({ kysely, ...(deps.capture === undefined ? {} : { capture: deps.capture }) }),
    );
  }
  return handlers;
}

/** Bootstraps the source tables, builds the handlers and returns the /sources service. */
export async function startBrainSourcesService(deps: BrainSourcesStartDeps): Promise<BrainSourcesService> {
  const ready = await bootstrapBrainSourceTables(deps.kysely, deps.bootstraps);
  return createBrainSourcesService({
    repository: deps.repository, resolver: deps.resolver, handlers: createBrainSourceHandlers(deps, ready),
    runner: deps.runner ?? runBrainSourceSync,
    ...(deps.hooks === undefined ? {} : { hooks: deps.hooks }),
    ...(deps.limits === undefined ? {} : { limits: deps.limits }),
    ...(deps.gitSync === undefined ? {} : { gitSync: deps.gitSync }),
    ...(deps.accounts === undefined ? {} : { accounts: deps.accounts }),
  });
}
