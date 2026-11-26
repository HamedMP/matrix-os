import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createBotIntegrationClient, createLocalIntegrationTransport, type BotIntegrationTransport } from "../../../packages/gateway/src/bots/integration-client.js";
import { createBotResourceCandidates, readBotResourceGitHubReviewConfig } from "../../../packages/gateway/src/bots/resource-grant-candidates.js";
import type { PipedreamConnectClient } from "../../../packages/gateway/src/integrations/pipedream.js";
import { createIntegrationReadCallRoutes } from "../../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../../packages/gateway/src/platform-db.js";
import { requireRequestPrincipal } from "../../../packages/gateway/src/request-principal.js";

const ownerId = "user_owner_1";
const agentId = "bot_0123456789abcdef";
const chatId = "chat_0123456789abcdef";
const match = { id: 1234567, full_name: "matrix-qa/review-fixture", permissions: { pull: true } };
const config = { repositoryId: "1234567", fullName: "matrix-qa/review-fixture" };
const account = { id: "gh_connection_verified", service: "github", account_label: "test-github", status: "active" };

function harness(data: unknown[], connections = [account]) {
  const transport = vi.fn<BotIntegrationTransport>(async (_actor, request) => Response.json(request.path === "/" ? connections : { data }));
  return { transport, client: createBotIntegrationClient(transport) };
}

describe("owner Agent resource candidate discovery", () => {
  it("uses the exact owner and active GitHub connection to offer only the approved, readable repository", async () => {
    const { transport, client } = harness([match, { ...match, id: 5, full_name: "matrix-qa/unapproved" }]);
    const providers = createBotResourceCandidates({ client, githubReview: config, runtimeOwnerId: ownerId });

    expect(await providers.list({ ownerId, agentId, chatId })).toEqual([{
      connectionId: account.id, label: config.fullName,
      scope: { kind: "github_repository", ...config },
    }]);
    expect(transport.mock.calls.map(([actor, request]) => [actor, request.method, request.path])).toEqual([
      [ownerId, "GET", "/"], [ownerId, "POST", "/read-call"],
    ]);
    expect(transport.mock.calls[1]?.[1]).toMatchObject({
      readScope: true, body: { service: "github", action: "list_repos", connectionId: account.id, label: account.account_label },
    });
  });

  it("fails closed for missing approval, another owner, ambiguous accounts, and missing exact provider read permission", async () => {
    const { transport, client } = harness([match]);
    expect(await createBotResourceCandidates({ client, runtimeOwnerId: ownerId }).list({ ownerId, agentId, chatId })).toEqual([]);
    expect(await createBotResourceCandidates({ client, githubReview: config, runtimeOwnerId: ownerId }).list({ ownerId: "user_other", agentId, chatId })).toEqual([]);
    expect(transport).not.toHaveBeenCalled();

    const ambiguous = harness([match], [account, { ...account, id: "gh_connection_other" }]);
    expect(await createBotResourceCandidates({ client: ambiguous.client, githubReview: config, runtimeOwnerId: ownerId }).list({ ownerId, agentId, chatId })).toEqual([]);
    expect(ambiguous.transport).toHaveBeenCalledTimes(1);

    const unverified = harness([
      { ...match, permissions: { pull: false } },
      { ...match, full_name: "matrix-qa/renamed" },
      { ...match, id: 42 },
    ]);
    expect(await createBotResourceCandidates({ client: unverified.client, githubReview: config, runtimeOwnerId: ownerId }).list({ ownerId, agentId, chatId })).toEqual([]);
  });

  it("requires a Dev runtime and a valid approved repository ID and canonical name in trusted configuration", () => {
    const configured = {
      MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_ID: "1234567",
      MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_FULL_NAME: "matrix-qa/review-fixture",
    };
    expect(readBotResourceGitHubReviewConfig(configured)).toBeUndefined();
    expect(readBotResourceGitHubReviewConfig({ ...configured, MATRIX_RUNTIME_SLOT: "primary" })).toBeUndefined();
    expect(readBotResourceGitHubReviewConfig({ ...configured, MATRIX_RUNTIME_SLOT: "dev" })).toEqual(config);
    expect(readBotResourceGitHubReviewConfig({ MATRIX_RUNTIME_SLOT: "dev", MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_ID: "1234567" })).toBeUndefined();
    expect(readBotResourceGitHubReviewConfig({
      MATRIX_RUNTIME_SLOT: "dev",
      MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_ID: "1234567",
      MATRIX_AGENT_GITHUB_REVIEW_REPOSITORY_FULL_NAME: "matrix-qa/..",
    })).toBeUndefined();
  });

  it("preserves GitHub identity and ACL through the existing read-only action transport", async () => {
    const proxyGet = vi.fn<PipedreamConnectClient["proxyGet"]>(async () => [match]);
    const db = {
      listConnectedServices: vi.fn(async () => [{ ...account, pipedream_account_id: "provider_owner_account" }]),
      getUserById: vi.fn(async () => ({ pipedream_external_id: "owner_project_identity" })),
      touchServiceUsage: vi.fn(async () => undefined),
    };
    const routes = new Hono();
    routes.get("/", (context) => context.json([account]));
    routes.route("/", createIntegrationReadCallRoutes({
      db: db as unknown as PlatformDb, pipedream: { proxyGet } as unknown as PipedreamConnectClient,
      resolveUserId: async (context) => requireRequestPrincipal(context).userId,
    }));
    const client = createBotIntegrationClient(createLocalIntegrationTransport(routes));
    const providers = createBotResourceCandidates({ client, githubReview: config, runtimeOwnerId: ownerId });

    expect(await providers.list({ ownerId, agentId, chatId })).toMatchObject([{ scope: { kind: "github_repository", ...config } }]);
    expect(db.listConnectedServices).toHaveBeenCalledExactlyOnceWith(ownerId);
    expect(proxyGet).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      externalUserId: "owner_project_identity", accountId: "provider_owner_account", url: "https://api.github.com/user/repos",
    }));
  });
});
