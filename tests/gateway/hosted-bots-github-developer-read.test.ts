import { describe, expect, it, vi } from "vitest";
import type { GithubDeveloperCommand } from "../../packages/gateway/src/bots/github-developer-service.js";
import {
  createHostedBotsGithubRead,
  validateHostedBotsGithubReadParams,
} from "../../packages/gateway/src/hosted-bots/github-developer-read.js";

const ownerHome = "/matrix-owner";
const repo = "HamedMP/matrix-os";
const viewer = { id: "github-node-1", login: "owner" };
const pr = {
  number: 42, title: "A fixture pull request", url: `https://github.com/${repo}/pull/42`,
  state: "OPEN", isDraft: false,
};

function stdout(data: unknown) {
  return { stdout: JSON.stringify({ data }), stderr: "" };
}

function createFixture() {
  const run = vi.fn<GithubDeveloperCommand>().mockResolvedValue(stdout({ viewer }));
  const service = createHostedBotsGithubRead({ homePath: ownerHome, run });
  return { run, service, signal: new AbortController().signal };
}

describe("Hosted Bots GitHub Developer read", () => {
  it("discovers a stable binding through GitHub's authenticated viewer using only the owner environment", async () => {
    const { run, service, signal } = createFixture();
    vi.stubEnv("GH_TOKEN", "host-environment-token");
    vi.stubEnv("GITHUB_TOKEN", "different-host-environment-token");
    try {
      const account = await service.account(signal);
      expect(account).toEqual({
        id: expect.stringMatching(/^github-developer:[a-f0-9]{64}$/),
        service: "github", label: "GitHub Developer · owner",
      });
      run.mockResolvedValueOnce(stdout({ viewer: { ...viewer, login: "renamed" } }));
      expect(await service.account(signal)).toMatchObject({ id: account!.id, label: "GitHub Developer · renamed" });
      const [command, args, options] = run.mock.calls[0]!;
      expect(command).toBe("gh");
      expect(args.slice(0, 4)).toEqual(["api", "graphql", "--hostname", "github.com"]);
      expect(args.join(" ")).toContain("viewer { id login }");
      expect(options).toMatchObject({
        cwd: ownerHome, env: { GH_CONFIG_DIR: `${ownerHome}/.config/gh`, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" },
        maxBuffer: expect.any(Number), killSignal: "SIGKILL",
      });
      expect(options.env.GH_TOKEN).toBeUndefined();
      expect(options.env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("returns only bounded list fields and treats merged PRs as closed", async () => {
    const { run, service, signal } = createFixture();
    const account = (await service.account(signal))!;
    run.mockResolvedValueOnce(stdout({
      viewer, repository: { nameWithOwner: repo, pullRequests: { nodes: [{
        ...pr, state: "MERGED", body: "not part of the list", accessToken: "wrong field",
      }] } },
    }));
    expect(await service.read("list_prs", { repo, per_page: 1, state: "closed" }, account.id, signal)).toEqual([{
      number: 42, title: pr.title, html_url: pr.url, state: "closed", draft: false, merged: true,
    }]);
    const [, argv] = run.mock.calls.at(-1)!;
    expect(argv).toEqual(expect.arrayContaining([
      "owner=HamedMP", "name=matrix-os", "limit=1", "states[]=CLOSED", "states[]=MERGED",
    ]));
    expect(argv.join(" ")).toContain("viewer { id login }");
    expect(argv.join(" ")).not.toContain("body");
  });

  it("reads the exact approved pull request and its body and revisions", async () => {
    const { run, service, signal } = createFixture();
    const account = (await service.account(signal))!;
    const body = "A fixture pull request body";
    const headRefOid = "b".repeat(40);
    const baseRefOid = "a".repeat(40);
    run.mockResolvedValueOnce(stdout({
      viewer, repository: { nameWithOwner: repo, pullRequest: {
        ...pr, body, headRefName: "topic", baseRefName: "main", headRefOid, baseRefOid,
      } },
    }));
    expect(await service.read("get_pr", { repo, pullNumber: 42 }, account.id, signal)).toEqual({
      number: 42, title: pr.title, html_url: pr.url, state: "open", draft: false, merged: false,
      body, head: { ref: "topic", sha: headRefOid }, base: { ref: "main", sha: baseRefOid },
    });
    expect(run.mock.calls.at(-1)?.[1]).toContain("number=42");
  });

  it("rejects unsupported selectors and invalid parameters before starting GitHub", async () => {
    const { run, service, signal } = createFixture();
    for (const params of [
      { repo: "@read-file" }, { repo: "https://github.com/HamedMP/matrix-os" }, { repo: "HamedMP/../matrix-os" },
      { repo, page: 2 }, { repo, per_page: 11 }, { repo, state: "merged" }, { repo, unexpected: true },
    ]) {
      expect(validateHostedBotsGithubReadParams("list_prs", params)).toBe(false);
      await expect(service.read("list_prs", params, "github-developer:" + "a".repeat(64), signal)).rejects.toMatchObject({ code: "invalid" });
    }
    expect(validateHostedBotsGithubReadParams("get_pr", { repo, pullNumber: 0 })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("withholds data if the query runs under a different account or returns a different repository", async () => {
    const { run, service, signal } = createFixture();
    const account = (await service.account(signal))!;
    const repository = { nameWithOwner: repo, pullRequests: { nodes: [pr] } };
    run.mockResolvedValueOnce(stdout({ viewer: { ...viewer, id: "different-user" }, repository }));
    await expect(service.read("list_prs", { repo, per_page: 1 }, account.id, signal)).rejects.toMatchObject({ code: "denied" });
    run.mockResolvedValueOnce(stdout({ viewer, repository: { ...repository, nameWithOwner: "HamedMP/other" } }));
    await expect(service.read("list_prs", { repo, per_page: 1 }, account.id, signal)).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not expose raw gh errors and never runs a cancelled command", async () => {
    const { run, service, signal } = createFixture();
    const account = (await service.account(signal))!;
    run.mockRejectedValueOnce(new Error("private CLI output"));
    await expect(service.account(signal)).resolves.toBeNull();
    run.mockRejectedValueOnce(new Error("private CLI output"));
    await expect(service.read("list_prs", { repo }, account.id, signal)).rejects.toThrow("Integration request failed: unavailable");
    run.mockClear();
    await expect(service.read("list_prs", { repo }, account.id, AbortSignal.abort())).rejects.toMatchObject({ code: "unavailable" });
    expect(run).not.toHaveBeenCalled();
  });
});
