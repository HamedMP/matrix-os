import { describe, expect, it, vi } from "vitest";
import { getAction, getService } from "../../packages/gateway/src/integrations/registry.js";
import {
  GitHubApiError,
  GitHubOAuthClient,
  executeGitHubIntegrationAction,
} from "../../packages/gateway/src/integrations/github-oauth.js";

const actionInputs: Record<string, Record<string, unknown>> = {
  list_repos: {},
  list_issues: { repo: "matrix-os/core" },
  create_issue: { repo: "matrix-os/core", title: "A bounded issue", labels: "bug, urgent" },
  list_prs: { repo: "matrix-os/core" },
  get_notifications: {},
  get_pr: { repo: "matrix-os/core", pullNumber: 7 },
  list_pr_reviews: { repo: "matrix-os/core", pullNumber: 7 },
  list_pr_review_comments: { repo: "matrix-os/core", pullNumber: 7 },
  list_pr_files: { repo: "matrix-os/core", pullNumber: 7 },
  list_pr_commits: { repo: "matrix-os/core", pullNumber: 7 },
  list_check_runs: { repo: "matrix-os/core", ref: "main" },
};

function client(fetchFn: typeof fetch) {
  return new GitHubOAuthClient({
    clientId: "client-123",
    clientSecret: "secret-456",
    callbackUrl: "https://app.matrix-os.com/api/integrations/oauth/github/callback",
    fetch: fetchFn,
  });
}

describe("direct GitHub integration transport", () => {
  it("dispatches all eleven reviewed actions to fixed GitHub API URLs with bounded bearer auth", async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const oauth = client(fetchFn);
    const service = getService("github")!;

    for (const [actionId, params] of Object.entries(actionInputs)) {
      const action = getAction("github", actionId)!;
      await expect(executeGitHubIntegrationAction({
        client: oauth,
        accessToken: "gho_access",
        action,
        params,
      })).resolves.toEqual({ data: { ok: true } });
    }

    expect(fetchFn).toHaveBeenCalledTimes(11);
    for (const [url, init] of fetchFn.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://api.github.com");
      expect(init).toEqual(expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          authorization: "Bearer gho_access",
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        }),
      }));
    }
    expect(service.actions).toEqual(expect.objectContaining(
      Object.fromEntries(Object.keys(actionInputs).map((id) => [id, expect.any(Object)])),
    ));

    const createCall = fetchFn.mock.calls.find(([url]) => String(url).endsWith("/repos/matrix-os/core/issues"))!;
    expect(createCall[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(createCall[1]!.body))).toEqual({ title: "A bounded issue", labels: ["bug", "urgent"] });
  });

  it("rejects non-GitHub registry URLs before dispatch", async () => {
    const fetchFn = vi.fn();
    await expect(executeGitHubIntegrationAction({
      client: client(fetchFn),
      accessToken: "gho_access",
      action: {
        description: "unsafe",
        risk: "read",
        params: {},
        directApi: { method: "GET", url: "https://attacker.invalid/steal" },
      },
      params: {},
    })).rejects.toBeInstanceOf(GitHubApiError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("caps action responses and classifies authorization failures without returning provider bodies", async () => {
    const oversized = client(vi.fn(async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 })));
    await expect(executeGitHubIntegrationAction({
      client: oversized,
      accessToken: "gho_access",
      action: getAction("github", "list_repos")!,
      params: {},
    })).rejects.toMatchObject({ name: "GitHubApiError", kind: "invalid_response" });

    const denied = client(vi.fn(async () => new Response(JSON.stringify({ message: "secret organization policy" }), { status: 401 })));
    await expect(executeGitHubIntegrationAction({
      client: denied,
      accessToken: "gho_access",
      action: getAction("github", "list_repos")!,
      params: {},
    })).rejects.toMatchObject({ name: "GitHubApiError", kind: "unauthorized", message: "GitHub request failed" });
  });
});
