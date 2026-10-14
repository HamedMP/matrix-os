import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HandoffApiError, createHandoffGateway } from "../../packages/sync-client/src/cli/handoff/gateway-api.js";
import { cleanupCommand } from "../../packages/sync-client/src/cli/handoff/remote-scripts.js";

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: Buffer;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[];
let respond: (req: Seen) => { status: number; body: unknown };

beforeEach(async () => {
  seen = [];
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method!, url: req.url!, auth: req.headers.authorization, type: req.headers["content-type"], body: Buffer.concat(chunks) };
      seen.push(entry);
      const reply = respond(entry);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("handoff gateway client", () => {
  it("sends authenticated requests to the project, worktree, chat and run routes", async () => {
    respond = ({ url, method }) => {
      if (url.startsWith("/api/workspace/projects")) return { status: 200, body: { projects: [{ id: "proj_1", slug: "app", name: "app", kind: "github", localPath: "/h/projects/app/repo", github: { owner: "acme", repo: "app", htmlUrl: "x", authState: "ok" }, extra: true }], nextCursor: null } };
      if (url === "/api/projects/app/worktrees" && method === "POST") return { status: 201, body: { worktree: { id: "wt_0123456789abcdef", path: "/h/worktrees/app/wt_0123456789abcdef", currentBranch: "feat/x", dirtyState: "unknown" } } };
      if (url.startsWith("/api/chat-providers")) return { status: 200, body: { revision: "r", drivers: [], instances: [{ id: "codex_default", driverKind: "codex", availability: "available", models: [{ id: "m", availability: "available" }], setupActions: [], supports: { interactionModes: ["default"], permissionModes: ["supervised"] } }] } };
      if (url === "/api/chats") return { status: 201, body: { chat: { id: "chat_abc", revision: 0, title: "t" }, projectId: "proj_1" } };
      if (url === "/api/chats/chat_abc/turns") return { status: 202, body: { admission: "accepted" } };
      if (url === "/api/terminal/run") return { status: 200, body: { stdout: "result=ok\n", stderr: "", exitCode: 0, signal: null } };
      return { status: 404, body: { error: "not_found" } };
    };
    const gateway = createHandoffGateway({ gatewayUrl: `${baseUrl}/`, token: "tkn" });

    const projects = await gateway.listProjects();
    expect(projects[0]).toMatchObject({ id: "proj_1", github: { owner: "acme", repo: "app" } });
    expect((await gateway.createWorktree("app", "feat/x")).id).toBe("wt_0123456789abcdef");
    expect((await gateway.providerCatalog())[0]!.id).toBe("codex_default");
    expect(await gateway.createChat({ clientRequestId: "req_a", title: "t", projectId: "proj_1", currentSelection: { instanceId: "codex_default", model: "m" } })).toEqual({ id: "chat_abc", revision: 0 });
    await gateway.startTurn("chat_abc", { clientRequestId: "req_b" });
    const command = cleanupCommand({ uploadId: "handoff-202610141200-aaaaaaaaaaaa", repoPath: null });
    expect((await gateway.run(command)).stdout).toBe("result=ok\n");

    expect(seen.every((request) => request.auth === "Bearer tkn")).toBe(true);
    expect(seen.map((request) => `${request.method} ${request.url.split("?")[0]}`)).toEqual([
      "GET /api/workspace/projects",
      "POST /api/projects/app/worktrees",
      "GET /api/chat-providers",
      "POST /api/chats",
      "POST /api/chats/chat_abc/turns",
      "POST /api/terminal/run",
    ]);
    expect(seen[0]!.url).toBe("/api/workspace/projects?visibility=active");
    expect(JSON.parse(seen[1]!.body.toString())).toEqual({ branch: "feat/x" });
    expect(seen[1]!.type).toBe("application/json");
    const run = JSON.parse(seen[5]!.body.toString());
    expect(run).toMatchObject({ cwd: "~", command: ["sh", "-c", expect.any(String), "matrix-handoff", "handoff-202610141200-aaaaaaaaaaaa", "", ""] });
    expect(seen[5]!.body.length).toBeLessThan(16_384);
  });

  it("uploads raw bytes with force to the blob route", async () => {
    respond = () => ({ status: 200, body: { ok: true, path: "data/matrix-handoff/x/bundle.part-0000", size: 4 } });
    const dir = await mkdtemp(join(tmpdir(), "handoff-api-"));
    try {
      const file = join(dir, "part");
      await writeFile(file, "abcd");
      await createHandoffGateway({ gatewayUrl: baseUrl, token: "tkn" }).uploadFile(file, "data/matrix-handoff/x/bundle.part-0000");
      const url = new URL(seen[0]!.url, baseUrl);
      expect(seen[0]!.method).toBe("PUT");
      expect(url.pathname).toBe("/api/files/blob");
      expect(url.searchParams.get("path")).toBe("data/matrix-handoff/x/bundle.part-0000");
      expect(url.searchParams.get("force")).toBe("true");
      expect(seen[0]!.body.toString()).toBe("abcd");
      expect(seen[0]!.type).toBe("application/octet-stream");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("maps gateway error shapes to stable codes and rejects malformed success bodies", async () => {
    const gateway = createHandoffGateway({ gatewayUrl: baseUrl, token: "tkn" });
    respond = () => ({ status: 424, body: { error: { code: "github_auth_required", message: "GitHub authentication is required" } } });
    await expect(gateway.createProject({ mode: "github" })).rejects.toMatchObject({ status: 424, code: "github_auth_required" });
    respond = () => ({ status: 401, body: { error: "unauthorized" } });
    await expect(gateway.listProjects()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    respond = () => ({ status: 500, body: { error: "Postgres says: relation does not exist" } });
    await expect(gateway.listProjects()).rejects.toMatchObject({ code: "request_failed" });
    respond = () => ({ status: 200, body: { projects: "nope" } });
    const error = await gateway.listProjects().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HandoffApiError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });
});
