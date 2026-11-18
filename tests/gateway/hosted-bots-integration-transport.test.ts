import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { createHostedBotsDriveApproval } from "../../packages/gateway/src/hosted-bots/drive-approval.js";
import { bindHostedBotsDriveSocket } from "../../packages/gateway/src/hosted-bots/drive-approval-runtime.js";
import { createHostedBotsGithubRead } from "../../packages/gateway/src/hosted-bots/github-developer-read.js";
// @ts-expect-error The preview ships this isolated Node script as-is.
import { integrationToolReply } from "../../scripts/openmausbot/matrix-drive-mcp.mjs";

it("returns a GitHub Developer PR body through the Unix MCP socket only after owner approval", async () => {
  const repo = "octocat/Hello-World";
  const input = { service: "github", action: "get_pr", params: { repo, pullNumber: 1 } };
  const ownerId = "user_preview_owner";
  const viewer = { id: "github-fixture-node", login: "preview-owner" };
  const pr = { number: 1, title: "Fixture pull request", state: "CLOSED", body: "Fixture pull request body",
    url: `https://github.com/${repo}/pull/1`, isDraft: false,
    headRefName: "patch", headRefOid: "a".repeat(40), baseRefName: "main", baseRefOid: "b".repeat(40) };
  const directory = await mkdtemp("/tmp/matrix-integrations-");
  const run = vi.fn(async (command: string, args: string[]) => {
    expect(command).toBe("gh");
    expect(args).toContain("graphql");
    const repository = args.some(arg => arg.includes("pullRequest("))
      ? { nameWithOwner: repo, pullRequest: pr }
      : undefined;
    return { stdout: JSON.stringify({ data: { viewer, repository } }), stderr: "" };
  });
  const pipedream = { inventory: vi.fn(), describe: vi.fn(), call: vi.fn() };
  const broker = createHostedBotsDriveApproval({
    admitted: true, ownerId, isOwner: (c) => c.req.header("x-test-owner") === ownerId,
    integration: pipedream, github: createHostedBotsGithubRead({ homePath: directory, run }),
  });
  const path = "/api/hosted-bots/integrations";
  const owner = new Hono();
  owner.route(path, broker.integrationOwnerRoutes);
  const headers = { "x-test-owner": ownerId, "content-type": "application/json" };
  const socket = join(directory, "drive.sock");
  let close: (() => Promise<void>) | undefined;
  try {
    close = await bindHostedBotsDriveSocket(socket, broker.guestRoutes);
    const tool = integrationToolReply(input, socket);
    const id = await vi.waitFor(async () => {
      const snapshot = await (await owner.request(path, { headers })).json();
      expect(snapshot.requests).toEqual([{
        ...input, id: expect.any(String), expiresAt: expect.any(Number), status: "pending",
      }]);
      expect(snapshot.accounts).toEqual([]);
      return snapshot.requests[0].id as string;
    });
    expect(run).not.toHaveBeenCalled();
    const review = await (await owner.request(`${path}?includeAccounts=1`, { headers })).json();
    expect(review.accounts).toEqual([{ id: expect.stringMatching(/^github-developer:/), service: "github",
      label: "GitHub Developer · preview-owner" }]);
    expect(run).toHaveBeenCalledOnce();
    expect((await owner.request(`${path}/${id}/decision`, {
      method: "POST", headers, body: JSON.stringify({ decision: "allow", accountId: review.accounts[0].id }),
    })).status).toBe(202);
    const reply = await tool;
    expect(reply.isError).toBeUndefined();
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ data: {
      number: pr.number, title: pr.title, state: "closed", body: pr.body,
    } });
    expect(run.mock.calls.filter(([, args]) => args.some(arg => arg.includes("pullRequest(")))).toHaveLength(1);
    expect(pipedream.inventory).not.toHaveBeenCalled();
    expect(pipedream.describe).not.toHaveBeenCalled();
    expect(pipedream.call).not.toHaveBeenCalled();
  } finally {
    broker.close();
    await close?.();
    await rm(directory, { force: true, recursive: true });
  }
});
