import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod/v4";
import type { GithubDeveloperCommand } from "../bots/github-developer-service.js";
import { BotIntegrationError } from "../bots/integration-client.js";
import { githubOwnerEnvironment } from "../github-owner-environment.js";

const exec = promisify(execFile);
const MAX_LIST_SIZE = 10;
const Repo = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/)
  .refine((repo) => !repo.includes(".."));
const PullNumber = z.number().int().min(1).max(2_147_483_647);
const GetParams = z.strictObject({ repo: Repo, pullNumber: PullNumber });
const ListParams = z.strictObject({
  repo: Repo,
  page: z.literal(1).optional(),
  per_page: z.number().int().min(1).max(MAX_LIST_SIZE).default(5),
  state: z.enum(["open", "closed", "all"]).default("open"),
});
const Viewer = z.object({
  id: z.string().min(1).max(128),
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
});
const AccountId = z.string().regex(/^github-developer:[a-f0-9]{64}$/);
const GraphqlEnvelope = z.object({ data: z.unknown(), errors: z.never().optional() });
const Repository = z.object({ nameWithOwner: Repo });
const PullRequest = z.object({
  number: PullNumber,
  title: z.string().max(1024),
  url: z.string().max(256),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
});
const GitObjectId = z.string().regex(/^[a-f0-9]{40}$/);
const PullRequestDetail = PullRequest.extend({
  body: z.string().max(20 * 1024),
  headRefName: z.string().min(1).max(1024),
  headRefOid: GitObjectId,
  baseRefName: z.string().min(1).max(1024),
  baseRefOid: GitObjectId,
});
const ViewerResult = z.object({ viewer: Viewer });
const ListResult = ViewerResult.extend({
  repository: Repository.extend({ pullRequests: z.object({ nodes: z.array(PullRequest).max(MAX_LIST_SIZE) }) }),
});
const GetResult = ViewerResult.extend({
  repository: Repository.extend({ pullRequest: PullRequestDetail.nullable() }),
});

const viewerFields = "viewer { id login }";
const pullFields = "number title url state isDraft";
const accountQuery = `query { ${viewerFields} }`;
const listQuery = `query($owner: String!, $name: String!, $limit: Int!, $states: [PullRequestState!]) {
  ${viewerFields}
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequests(first: $limit, states: $states, orderBy: {field: CREATED_AT, direction: DESC}) {
      nodes { ${pullFields} }
    }
  }
}`;
const getQuery = `query($owner: String!, $name: String!, $number: Int!) {
  ${viewerFields}
  repository(owner: $owner, name: $name) {
    nameWithOwner
    pullRequest(number: $number) { ${pullFields} body headRefName headRefOid baseRefName baseRefOid }
  }
}`;

const states = { open: ["OPEN"], closed: ["CLOSED", "MERGED"], all: ["OPEN", "CLOSED", "MERGED"] } as const;
type Action = "get_pr" | "list_prs";

function parseRequest(action: Action, params: Record<string, unknown>) {
  if (action === "get_pr") {
    const parsed = GetParams.safeParse(params);
    return parsed.success ? { action, params: parsed.data } : null;
  }
  const parsed = ListParams.safeParse(params);
  return parsed.success ? { action, params: parsed.data } : null;
}

export function validateHostedBotsGithubReadParams(action: Action, params: Record<string, unknown>): boolean {
  return parseRequest(action, params) !== null;
}

function binding(id: string) {
  return `github-developer:${createHash("sha256").update(id).digest("hex")}`;
}

function projectPull(repo: string, pull: z.infer<typeof PullRequest>) {
  if (pull.url.toLowerCase() !== `https://github.com/${repo}/pull/${pull.number}`.toLowerCase()) {
    throw new BotIntegrationError("unavailable");
  }
  return {
    number: pull.number, title: pull.title, html_url: pull.url,
    state: pull.state === "OPEN" ? "open" : "closed", draft: pull.isDraft, merged: pull.state === "MERGED",
  };
}

export function createHostedBotsGithubRead(deps: { homePath: string; run?: GithubDeveloperCommand }) {
  const run = deps.run ?? exec;
  const env = {
    ...githubOwnerEnvironment(deps.homePath),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  };

  async function query<T extends z.ZodType>(schema: T, source: string, variables: string[], signal: AbortSignal): Promise<z.infer<T>> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(6_000)]);
    if (bounded.aborted) throw new BotIntegrationError("unavailable");
    try {
      const { stdout } = await run("gh", ["api", "graphql", "--hostname", "github.com", "--raw-field", `query=${source}`, ...variables], {
        cwd: deps.homePath, env, signal: bounded, maxBuffer: 64 * 1024, killSignal: "SIGKILL",
      });
      bounded.throwIfAborted();
      const result = GraphqlEnvelope.parse(JSON.parse(stdout));
      return schema.parse(result.data);
    } catch (error: unknown) {
      if (!bounded.aborted) console.warn("[hosted-bots-github] Read unavailable", error instanceof Error ? error.name : "UnknownError");
      throw new BotIntegrationError("unavailable");
    }
  }

  function assertBinding(viewer: z.infer<typeof Viewer>, accountId: string, actualRepo: string, approvedRepo: string) {
    // Verify the viewer from the same API request as the repository data.
    if (binding(viewer.id) !== accountId) throw new BotIntegrationError("denied");
    if (actualRepo.toLowerCase() !== approvedRepo.toLowerCase()) throw new BotIntegrationError("unavailable");
  }

  return {
    async account(signal: AbortSignal) {
      try {
        const { viewer } = await query(ViewerResult, accountQuery, [], signal);
        return { id: binding(viewer.id), service: "github" as const, label: `GitHub Developer · ${viewer.login}` };
      } catch (error: unknown) {
        if (error instanceof BotIntegrationError && error.code === "unavailable") return null;
        throw error;
      }
    },
    async read(action: Action, params: Record<string, unknown>, accountId: string, signal: AbortSignal): Promise<unknown> {
      const input = parseRequest(action, params);
      if (!input || !AccountId.safeParse(accountId).success) throw new BotIntegrationError("invalid");
      const { repo } = input.params;
      const [owner, name] = repo.split("/");
      const variables = ["--raw-field", `owner=${owner}`, "--raw-field", `name=${name}`];
      if (input.action === "get_pr") {
        const { pullNumber } = input.params;
        const result = await query(GetResult, getQuery, [...variables, "--field", `number=${pullNumber}`], signal);
        assertBinding(result.viewer, accountId, result.repository.nameWithOwner, repo);
        const pull = result.repository.pullRequest;
        if (!pull || pull.number !== pullNumber) throw new BotIntegrationError("missing");
        return {
          ...projectPull(repo, pull), body: pull.body,
          head: { ref: pull.headRefName, sha: pull.headRefOid },
          base: { ref: pull.baseRefName, sha: pull.baseRefOid },
        };
      }

      const { per_page: limit, state } = input.params;
      const requestedStates: readonly z.infer<typeof PullRequest>["state"][] = states[state];
      const result = await query(ListResult, listQuery, [
        ...variables, "--field", `limit=${limit}`,
        ...requestedStates.flatMap((value) => ["--raw-field", `states[]=${value}`]),
      ], signal);
      assertBinding(result.viewer, accountId, result.repository.nameWithOwner, repo);
      const pulls = result.repository.pullRequests.nodes;
      if (pulls.length > limit || pulls.some((pull) => !requestedStates.includes(pull.state))) {
        throw new BotIntegrationError("unavailable");
      }
      return pulls.map((pull) => projectPull(repo, pull));
    },
  };
}
