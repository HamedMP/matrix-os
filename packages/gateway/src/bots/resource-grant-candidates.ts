import { z } from "zod/v4";
import { BotIntegrationError, type BotIntegrationClient, type BotIntegrationConnection } from "./integration-client.js";
import { GithubReviewRepositorySchema, type BotResourceGrantProviders } from "./resource-grant-scope.js";

const REPOSITORY_PAGE_SIZE = 30;
// Leave time for the binding and grant reads inside the shell's 10-second request budget.
const DISCOVERY_TIMEOUT_MS = 7_500;
const ReadableRepositorySchema = z.object({
  id: z.number().int().positive(),
  full_name: GithubReviewRepositorySchema.shape.fullName,
  permissions: z.object({ pull: z.literal(true) }),
});
const RepositoryPageSchema = z.array(z.unknown()).max(REPOSITORY_PAGE_SIZE);

export type BotGitHubReviewRepository = z.infer<typeof GithubReviewRepositorySchema>;

export function readBotResourceGitHubReviewConfig(env: NodeJS.ProcessEnv): BotGitHubReviewRepository | undefined {
  if (env.MATRIX_RUNTIME_SLOT !== "dev") return undefined;
  const parsed = GithubReviewRepositorySchema.safeParse({
    repositoryId: env.MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_ID,
    fullName: env.MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_FULL_NAME,
  });
  return parsed.success ? parsed.data : undefined;
}

async function verifyGitHubReviewRepository(
  client: Pick<BotIntegrationClient, "call">,
  ownerId: string,
  connection: Pick<BotIntegrationConnection, "connectionId" | "label">,
  repository: BotGitHubReviewRepository,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await client.call(ownerId, {
    service: "github", action: "list_repos", read: true,
    connectionId: connection.connectionId, label: connection.label,
    params: { page: 1, per_page: REPOSITORY_PAGE_SIZE },
  }, signal);
  const page = RepositoryPageSchema.safeParse(result.data);
  return page.success && page.data.some((row) => {
    const parsed = ReadableRepositorySchema.safeParse(row);
    return parsed.success && String(parsed.data.id) === repository.repositoryId
      && parsed.data.full_name === repository.fullName;
  });
}

/** The old Slack callback is independently bound to its original Bot and Chat. */
export function createBotResourceCandidates(options: {
  client?: Pick<BotIntegrationClient, "inventory" | "call">;
  githubReview?: BotGitHubReviewRepository;
  runtimeOwnerId?: string | null;
}): BotResourceGrantProviders {
  return {
    async list({ ownerId }, signal) {
      const { client, githubReview, runtimeOwnerId } = options;
      if (!client || !githubReview || ownerId !== runtimeOwnerId) return [];
      const boundedSignal = AbortSignal.any([AbortSignal.timeout(DISCOVERY_TIMEOUT_MS), ...(signal ? [signal] : [])]);
      try {
        const connections = (await client.inventory(ownerId, boundedSignal)).filter(({ service }) => service === "github");
        if (connections.length !== 1) return [];
        const [connection] = connections;
        if (!connection || !await verifyGitHubReviewRepository(client, ownerId, connection, githubReview, boundedSignal)) return [];
        return [{
          connectionId: connection.connectionId,
          label: githubReview.fullName,
          scope: { kind: "github_repository" as const, ...githubReview },
        }];
      } catch (error: unknown) {
        if (!(error instanceof BotIntegrationError)) throw error;
        console.warn("[bots] Resource candidate verification unavailable:", error.code);
        return [];
      }
    },
  };
}
