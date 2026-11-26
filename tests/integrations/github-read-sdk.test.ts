import { afterEach, expect, it, vi } from "vitest";
import { createPipedreamClient } from "../../packages/gateway/src/integrations/pipedream.js";
import { createIntegrationReadCallRoutes } from "../../packages/gateway/src/integrations/read-call.js";
import type { PlatformDb } from "../../packages/gateway/src/platform-db.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("returns GitHub PR metadata and patch JSON through the general read route and the installed proxy SDK", async () => {
  const origin = "https://sdk-fixture.invalid";
  const owner = "owner-fixture";
  const account = { id: "gh-connection", account_label: "Dev GitHub", service: "github", pipedream_account_id: "apn_fixture" };
  const head = "a".repeat(40);
  const pull = { number: 7, head: { sha: head }, changed_files: 1 };
  const files = [{ filename: "demo.txt", patch: "@@ -1 +1 @@\n-old\n+new" }];
  const targets: string[] = [];
  vi.stubEnv("PIPEDREAM_BASE_URL", origin);
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const endpoint = new URL(url);
    expect(endpoint.origin).toBe(origin);
    if (endpoint.pathname === "/v1/oauth/token" && init.method === "POST") {
      return Response.json({ access_token: "fixture-only", token_type: "Bearer", expires_in: 300 });
    }
    expect(init.method).toBe("GET");
    expect(endpoint.searchParams.get("external_user_id")).toBe(owner);
    expect(endpoint.searchParams.get("account_id")).toBe(account.pipedream_account_id);
    const target = new URL(Buffer.from(decodeURIComponent(endpoint.pathname.split("/").at(-1)!), "base64").toString("utf8"));
    targets.push(target.origin + target.pathname);
    return Response.json(target.pathname.endsWith("/files") ? files : pull);
  });
  const pipedream = await createPipedreamClient({ projectId: "prj_fixture", environment: "development", clientId: "fixture", clientSecret: "fixture" });
  const db = { listConnectedServices: async () => [account], getUserById: async () => ({ pipedream_external_id: owner }), touchServiceUsage: async () => undefined };
  const routes = createIntegrationReadCallRoutes({ db: db as unknown as PlatformDb, pipedream, resolveUserId: async () => owner });
  const read = async (action: string) => {
    const res = await routes.request("/read-call", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ service: "github", action, label: account.account_label, connectionId: account.id, params: { repo: "org/repo", pullNumber: 7 } }) });
    expect(res.status).toBe(200);
    return (await res.json()).data;
  };
  expect(await read("get_pr")).toEqual(pull);
  expect(await read("list_pr_files")).toEqual(files);
  expect(targets).toEqual(["https://api.github.com/repos/org/repo/pulls/7", "https://api.github.com/repos/org/repo/pulls/7/files"]);
});
