import { Hono } from "hono";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";
import type { PipedreamConnectClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { expect, it, vi } from "vitest";
import { createBotIntegrationClient, createLocalIntegrationTransport, type BotIntegrationTransport } from "../../packages/gateway/src/bots/integration-client.js";
import { mentionsPullReview, parseSlackReviewRequest, readRoutedReviewPatch } from "../../packages/gateway/src/slack/review-patch.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const repo = { id: 328, full_name: "test/sample", private: true };
const pull = {
  number: 6, changed_files: 1, additions: 1, deletions: 1,
  head: { sha: head, repo }, base: { sha: base, repo }
};
const file = {
  filename: "docs/sample.md", status: "modified", additions: 1, deletions: 1, changes: 2,
  contents_url: 'https://api.github.com/repos/test/sample/contents/docs/sample.md?ref=' + head,
  patch: "@@ -1 +1 @@\n-before\n+after"
};
const scope = { repositoryId: "328", fullName: "test/sample", connectionId: "account-test" };
const url = "https://github.com/test/sample/pull/6";
const text = 'Please review <' + url + '> at ' + head;
const req = { pullNumber: 6, expectedHead: head };

function harness(responses: unknown[], current = async () => true) {
  const transport = vi.fn<BotIntegrationTransport>(async (_, request) => Response.json(request.path === "/"
    ? [{ id: scope.connectionId, service: "github", status: "active", account_label: "dev" }]
    : { data: responses.shift() }));
  const run = () => readRoutedReviewPatch({
    client: createBotIntegrationClient(transport), ownerId: "owner", scope, request: req,
    current, signal: AbortSignal.timeout(5000)
  });
  return { transport, run };
}

it("accepts a single exact-repository review request and optional full head", () => {
  expect(parseSlackReviewRequest(text, scope.fullName)).toEqual(req);
  expect(parseSlackReviewRequest("Please review <" + url + "|the prepared PR>", scope.fullName)).toEqual({ pullNumber: 6 });
  expect(parseSlackReviewRequest("Please review <" + url + "|https://github.com/other/repo/pull/1>", scope.fullName)).toBeNull();
  expect(mentionsPullReview("The review is complete: " + url)).toBe(false);
  expect(parseSlackReviewRequest("<@U123> could you please review " + url, scope.fullName)).toEqual({ pullNumber: 6 });
  expect(parseSlackReviewRequest('Please review ' + url, scope.fullName)).toEqual({ pullNumber: 6 });
  for (const message of ['See ' + url, text.replace('test/sample', 'other/sample'), text + ' ' + url,
  text.replace('/6>', '/6?next=else>'), text.replace('github.com', 'github.com.evil.tld'), text.replace('/6>', '/6/files>')]) {
    expect(parseSlackReviewRequest(message, scope.fullName)).toBeNull();
  }
});

it("reads the actual full patch on the selected general integration account at the exact tested head", async () => {
  const { transport, run } = harness([pull, [file], pull]);
  const result = await run();
  expect(result).toMatchObject({ head, base, url, files: [{ filename: file.filename, patch: file.patch }], digest: expect.stringMatching(/^[a-f0-9]{64}$/) });
  expect(transport.mock.calls.map(([actor, r]) => [actor, r.path, r.body?.action])).toEqual([
    ["owner", "/", undefined], ["owner", "/read-call", "get_pr"], ["owner", "/read-call", "list_pr_files"], ["owner", "/read-call", "get_pr"]]);
  expect(transport.mock.calls.slice(1).every(([, r]) => r.body?.connectionId === scope.connectionId && r.readScope)).toBe(true);
});

it.each([
  ["missing patch", [pull, [{ ...file, patch: undefined }]]],
  ["incomplete hunk", [pull, [{ ...file, patch: "@@ -1,2 +1,2 @@\n-before\n+after" }]]],
  ["missing changed file", [{ ...pull, changed_files: 2 }, [file]]],
  ["unproven file head", [pull, [{ ...file, contents_url: file.contents_url.replace(head, base) }]]],
  ["foreign file contents", [pull, [{ ...file, contents_url: file.contents_url.replace("test/sample", "other/sample") }]]],
  ["repository replaced", [{ ...pull, base: { sha: base, repo: { ...repo, id: 22 } } }]],
  ["fork", [{ ...pull, head: { sha: head, repo: { ...repo, full_name: "someone/sample" } } }]],
  ["inconsistent repository visibility", [{ ...pull, head: { sha: head, repo: { ...repo, private: false } } }]],
  ["wrong head", [{ ...pull, head: { sha: base, repo } }]],
  ["retarget during read", [pull, [file], { ...pull, base: { sha: head, repo } }]],
  ["line count changed", [pull, [{ ...file, additions: 2 }]]],
] as const)("declines %s before returning any model input", async (_, responses) => {
  await expect(harness([...responses]).run()).rejects.toThrow();
});

it("rechecks local authority before every external access and stops immediately on revoke", async () => {
  let count = 0;
  const { transport, run } = harness([pull, [file], pull], async () => ++count < 3);
  await expect(run()).rejects.toThrow();
  expect(transport.mock.calls.map(([, r]) => r.body?.action)).toEqual([undefined, "get_pr"]);
});


it("uses the general read-call registry and exact GitHub GET endpoints on the assigned provider account", async () => {
  const account = { id: scope.connectionId, service: "github", account_label: "dev", status: "active", pipedream_account_id: "provider-account" };
  const proxyGet = vi.fn<PipedreamConnectClient["proxyGet"]>(async ({ url }) => url.endsWith("/files") ? [file] : pull);
  const db = {
    listConnectedServices: async () => [account], getUserById: async () => ({ pipedream_external_id: "provider-owner" }),
    touchServiceUsage: async () => undefined
  };
  const api = new Hono();
  api.get("/", c => c.json([account]));
  api.route("/", createIntegrationReadCallRoutes({
    db: db as unknown as PlatformDb, pipedream: { proxyGet } as unknown as PipedreamConnectClient,
    resolveUserId: async c => requireRequestPrincipal(c).userId
  }));
  const result = await readRoutedReviewPatch({
    client: createBotIntegrationClient(createLocalIntegrationTransport(api)), ownerId: "user_owner",
    scope, request: req, signal: AbortSignal.timeout(5000), current: async () => true
  });
  expect(result.files).toEqual([{ filename: file.filename, patch: file.patch }]);
  expect(proxyGet.mock.calls.map(([request]) => [request.accountId, request.url])).toEqual([
    ["provider-account", "https://api.github.com/repos/test/sample/pulls/6"],
    ["provider-account", "https://api.github.com/repos/test/sample/pulls/6/files"],
    ["provider-account", "https://api.github.com/repos/test/sample/pulls/6"],
  ]);
});

it("accepts an explicitly assigned public repository with the same immutable identity checks", async () => {
  const publicRepo = { ...repo, private: false };
  const publicPull = { ...pull, head: { sha:head, repo:publicRepo }, base:{ sha:base, repo:publicRepo } };
  const {run} = harness([publicPull,[file],publicPull]);
  await expect(run()).resolves.toMatchObject({repositoryId:String(repo.id), head, files:[{filename:file.filename,patch:file.patch}]});
});


it("preserves a complete unified patch including its optional final newline", async () => {
  const patch = file.patch + "\n";
  await expect(harness([pull, [{...file, patch}], pull]).run()).resolves.toMatchObject({ files:[{filename:file.filename,patch}] });
});
