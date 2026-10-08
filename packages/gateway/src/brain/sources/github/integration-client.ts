/**
 * GitHub client for integration mode: each resource is one read action of the integration registry's github
 * service, called for the owner through BrainIntegrationCaller. That path returns data only (no headers), so there
 * are no conditional requests and a full page means "maybe more".
 */
import type { BrainIntegrationCaller, BrainIntegrationCallOutcome, BrainSourceErrorCode } from "../../contracts.js";
import type { BrainGithubClient, BrainGithubFetchResult, BrainGithubResource } from "./types.js";

/** Registry read actions (packages/gateway/src/integrations/registry.ts, github service) this client calls. */
export const GITHUB_INTEGRATION_ACTIONS = {
  issues: "list_issues_since", pull: "brain_get_pr", pull_commits: "brain_list_pr_commits",
  pull_reviews: "brain_list_pr_reviews", pull_review_comments: "brain_list_pr_review_comments",
} as const satisfies Record<BrainGithubResource["kind"], string>;

const OUTCOME_CODES: Readonly<Record<Exclude<BrainIntegrationCallOutcome["status"], "ok" | "rate_limited">, BrainSourceErrorCode>> = {
  not_connected: "not_connected", unauthorized: "auth_failed", not_found: "remote_not_found",
  invalid: "config_invalid", unavailable: "provider_unavailable",
};

function paramsOf(repo: string, resource: BrainGithubResource): Record<string, string | number> {
  switch (resource.kind) {
    case "issues": return { repo, since: resource.since, page: resource.page, per_page: resource.perPage };
    case "pull": return { repo, number: resource.number };
    default: return { repo, number: resource.number, per_page: resource.perPage };
  }
}

export function createGithubIntegrationClient(options: {
  readonly caller: BrainIntegrationCaller; readonly ownerId: string; readonly repo: string; readonly label?: string;
}): BrainGithubClient {
  return {
    mode: "integration",
    async read(resource, signal): Promise<BrainGithubFetchResult> {
      let outcome: BrainIntegrationCallOutcome;
      try {
        outcome = await options.caller.call(options.ownerId, {
          service: "github", action: GITHUB_INTEGRATION_ACTIONS[resource.kind], params: paramsOf(options.repo, resource),
          ...(options.label === undefined ? {} : { label: options.label }),
        }, signal);
      } catch (error: unknown) {
        if (!signal.aborted) throw error;
        return { ok: false, code: "provider_timeout" };
      }
      if (outcome.status === "ok") {
        const perPage = "perPage" in resource ? resource.perPage : 0;
        return { ok: true, data: outcome.data, hasMore: Array.isArray(outcome.data) && perPage > 0 && outcome.data.length >= perPage };
      }
      if (outcome.status === "rate_limited") return { ok: false, code: "rate_limited", retryAfterSeconds: outcome.retryAfterSeconds };
      return { ok: false, code: OUTCOME_CODES[outcome.status] };
    },
  };
}
