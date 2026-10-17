/**
 * The github kind handler for sources/core: config parsing and storage, the repository identity, adapter creation
 * per run (credentials read then, never kept) and availability. One github source per project; its repository must
 * be the git source's github.com repository when that is known. Token mode is only for the gateway's own owner.
 */
import type { Kysely } from "kysely";
import {
  BrainFeatureError, type BrainGithubSourceConfig, type BrainIntegrationCallOutcome, type BrainIntegrationCaller,
  type BrainIntegrationService, type BrainResolvedProject,
  type BrainSourceKindAvailability, type BrainSourceKindHandler,
} from "../../contracts.js";
import type { BrainDatabase, BrainScopeKey } from "../../index.js";
import { createGithubAdapter } from "./adapter.js";
import { githubExternalRef, parseBrainGithubConfig, readGithubToken, viewBrainGithubConfig } from "./config.js";
import { gitSourceRepo, loadGithubConfig, saveGithubConfig } from "./database.js";
import { createGithubIntegrationClient } from "./integration-client.js";
import { createGithubRestClient } from "./rest-client.js";

export const GITHUB_AVAILABILITY_TIMEOUT_MS = 5_000;

export interface BrainGithubSourceHandlerDeps {
  readonly kysely: Kysely<BrainDatabase>;
  readonly integrations: BrainIntegrationCaller;
  readonly fetch?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
  /** Whether an integration transport is bound; false: integration mode is not_configured (token mode still works). */
  readonly isConfigured?: () => boolean;
  /** Connection lookup without a provider call (the same one the connectors use); absent: a one-row list_repos probe. */
  readonly isConnected?: (ownerId: string, service: BrainIntegrationService) => Promise<boolean>;
  /**
   * Principals that may use MATRIX_BRAIN_GITHUB_TOKEN: the gateway's configured owner. Absent or empty: nobody, so
   * a collaborator on a shared machine never reads repositories through the operator's token.
   */
  readonly tokenOwnerIds?: readonly string[];
}

/** False when the scope's git source is known to be another github.com repository. */
async function matchesGitSource(kysely: Kysely<BrainDatabase>, scope: BrainScopeKey, repo: string): Promise<boolean> {
  const gitRepo = await gitSourceRepo(kysely, scope);
  return gitRepo === null || gitRepo.toLowerCase() === repo.toLowerCase();
}

export function createBrainGithubSourceHandler(deps: BrainGithubSourceHandlerDeps): BrainSourceKindHandler<BrainGithubSourceConfig> {
  const env = deps.env ?? process.env;
  const tokenOwners = new Set((deps.tokenOwnerIds ?? []).slice(0, 8));
  const tokenFor = (ownerId: string): string | null => tokenOwners.has(ownerId) ? readGithubToken(env) : null;
  return {
    kind: "github",
    parseConfig: parseBrainGithubConfig,
    identify(_project: BrainResolvedProject, config: BrainGithubSourceConfig) {
      return { externalRef: githubExternalRef(config.repo), label: `GitHub ${config.repo}` };
    },
    // The repository conflict is refused before the source row exists; saveConfig checks again for a git source
    // that changed in between (the sources service then removes the new row).
    async checkConfig(scope, config) {
      if (!await matchesGitSource(deps.kysely, scope, config.repo)) throw new BrainFeatureError("source_conflict");
    },
    async saveConfig(scope, sourceId, config) {
      if (!await matchesGitSource(deps.kysely, scope, config.repo)) throw new BrainFeatureError("source_conflict");
      await saveGithubConfig(deps.kysely, scope, sourceId, config, new Date());
    },
    loadConfig: (scope, sourceId) => loadGithubConfig(deps.kysely, scope, sourceId),
    async createAdapter(ownerId, project, config) {
      if (!await matchesGitSource(deps.kysely, project.scope, config.repo)) return { ok: false, code: "config_invalid" };
      if (config.mode === "token") {
        const token = tokenFor(ownerId);
        if (token === null) return { ok: false, code: "not_connected" };
        return {
          ok: true,
          adapter: createGithubAdapter({
            kysely: deps.kysely,
            createClient: (conditional) => createGithubRestClient({
              token, repo: config.repo, conditional, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
            }),
          }),
        };
      }
      return {
        ok: true,
        adapter: createGithubAdapter({
          kysely: deps.kysely,
          createClient: () => createGithubIntegrationClient({
            caller: deps.integrations, ownerId, repo: config.repo,
            ...(config.accountLabel === undefined ? {} : { label: config.accountLabel }),
          }),
        }),
      };
    },
    viewConfig: viewBrainGithubConfig,
    async availability(ownerId): Promise<BrainSourceKindAvailability> {
      if (tokenFor(ownerId) !== null) return { available: true };
      if (deps.isConfigured?.() === false) return { available: false, reason: "not_configured" };
      if (deps.isConnected !== undefined) {
        return await deps.isConnected(ownerId, "github") ? { available: true } : { available: false, reason: "not_connected" };
      }
      const signal = AbortSignal.timeout(GITHUB_AVAILABILITY_TIMEOUT_MS);
      let outcome: BrainIntegrationCallOutcome;
      try {
        outcome = await deps.integrations.call(ownerId, { service: "github", action: "list_repos", params: { per_page: 1 } }, signal);
      } catch (error: unknown) {
        if (!signal.aborted) throw error;
        return { available: false, reason: "not_configured" };
      }
      if (outcome.status === "ok" || outcome.status === "rate_limited") return { available: true };
      if (outcome.status === "not_connected" || outcome.status === "unauthorized") return { available: false, reason: "not_connected" };
      return { available: false, reason: "not_configured" };
    },
  };
}
