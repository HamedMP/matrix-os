import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createIntegrationsMcpServer, type IntegrationsMcpToolSurface } from "../../packages/integrations-mcp/src/server.js";
import type { GatewayFetcher } from "../../packages/kernel/src/tools/integrations.js";
import { taskFixture } from "../contracts/fixtures/project-task.js";

const TOOLS = [
  "project_task_list", "project_task_get", "project_task_create", "project_task_update",
  "project_task_move", "project_task_comment", "project_task_start",
];

afterEach(() => vi.unstubAllEnvs());

async function connect(fetcher: GatewayFetcher, toolSurface: IntegrationsMcpToolSurface = "full") {
  const server = createIntegrationsMcpServer({ fetcher, toolSurface });
  const client = new Client({ name: "project-task-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(right), client.connect(left)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function gateway() {
  return vi.fn<GatewayFetcher>(async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/workspace/projects") return Response.json({ projects: [{ id: "proj_alpha", slug: "matrix-os", name: "Matrix" }], nextCursor: null });
    if (path === "/api/project-tasks/session") return Response.json({ session: { projectId: "proj_alpha", projectSlug: "matrix-os", taskId: "task_42" } });
    if (path.endsWith("/comments")) return Response.json({ comment: { id: "tcm_1", taskId: "task_42", author: "agent:chat_1", body: "PR is up", createdAt: "2026-11-20T10:00:00.000Z", editedAt: null } }, { status: 201 });
    if (path.endsWith("/move")) return Response.json({ error: { code: "task_agent_working", message: "Agent working" } }, { status: 409 });
    return Response.json({ task: taskFixture() });
  });
}

// Fault detected: harness agents (Claude Code, Codex) in a task session had no board tools,
// and a session could reach projects other than its own.
describe("project task tools on the integrations MCP server", () => {
  it.each(["full", "chat-call", "chat-call-drive"] as const)("advertises all seven tools on %s", async (surface) => {
    const { client, close } = await connect(gateway(), surface);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(TOOLS));
    } finally { await close(); }
  });

  it("advertises only the read tools on a discovery surface and none on narrow surfaces", async () => {
    const discovery = await connect(gateway(), "chat-discovery");
    try {
      const names = (await discovery.client.listTools()).tools.map((tool) => tool.name);
      expect(names.filter((name) => name.startsWith("project_task_"))).toEqual(["project_task_list", "project_task_get"]);
    } finally { await discovery.close(); }
    for (const surface of ["preview-drive-call", "custom-mcp-call", "jev-inbox-preview"] as const) {
      const narrow = await connect(gateway(), surface);
      try {
        const names = (await narrow.client.listTools()).tools.map((tool) => tool.name);
        expect(names.some((name) => name.startsWith("project_task_"))).toBe(false);
      } finally { await narrow.close(); }
    }
  });

  // Fault detected: a chat run's MCP child has no MATRIX_PROJECT_ID; its project comes from
  // the gateway's binding of the run token, never from the owner's project list.
  it("comments on the run's task from the gateway binding of the run token, with no actor", async () => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    const fetcher = gateway();
    const { client, close } = await connect(fetcher);
    try {
      const result = await client.callTool({ name: "project_task_comment", arguments: { body: "PR is up" } });
      expect(result.isError).not.toBe(true);
      const [url, init] = fetcher.mock.calls.at(-1)!;
      expect(url).toBe("http://localhost:4000/api/projects/matrix-os/tasks/task_42/comments");
      expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"a".repeat(64)}`);
      expect(JSON.parse(String(init.body))).toEqual({ body: "PR is up" });
      expect(fetcher.mock.calls.some(([called]) => called.includes("/api/workspace/projects"))).toBe(false);
    } finally { await close(); }
  });

  it("refuses a run token whose gateway binding disagrees with the session environment", async () => {
    vi.stubEnv("MATRIX_AGENT_INTEGRATIONS_TOKEN", "a".repeat(64));
    vi.stubEnv("MATRIX_PROJECT_ID", "proj_other");
    const fetcher = gateway();
    const { client, close } = await connect(fetcher);
    try {
      const result = await client.callTool({ name: "project_task_list", arguments: {} });
      expect(result.isError).toBe(true);
      expect(fetcher.mock.calls.some(([url]) => url.includes("/tasks"))).toBe(false);
    } finally { await close(); }
  });

  // Fault detected: owner-credential tools in a task session that lost MATRIX_PROJECT_ID
  // ran unbound and could reach any project's board.
  it("fails closed with owner credentials when a task id has no project binding", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "owner-token");
    vi.stubEnv("MATRIX_TASK_ID", "task_42");
    const fetcher = gateway();
    const { client, close } = await connect(fetcher);
    try {
      const result = await client.callTool({ name: "project_task_list", arguments: { project: "matrix-os" } });
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await close(); }
  });

  it("refuses another project and a closing move while the agent works", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "owner-token");
    vi.stubEnv("MATRIX_PROJECT_ID", "proj_alpha");
    vi.stubEnv("MATRIX_TASK_ID", "task_42");
    const fetcher = gateway();
    const { client, close } = await connect(fetcher);
    try {
      const other = await client.callTool({ name: "project_task_list", arguments: { project: "secret-project" } });
      expect(other.isError).toBe(true);
      expect(fetcher.mock.calls.some(([url]) => url.includes("secret-project"))).toBe(false);
      const move = await client.callTool({ name: "project_task_move", arguments: { status: "done" } });
      expect(move.isError).toBe(true);
      expect(JSON.stringify(move.content)).toContain("force");
    } finally { await close(); }
  });

  it("refuses every call when the run's project binding is malformed", async () => {
    vi.stubEnv("MATRIX_AUTH_TOKEN", "owner-token");
    vi.stubEnv("MATRIX_PROJECT_ID", "../etc");
    const fetcher = gateway();
    const { client, close } = await connect(fetcher);
    try {
      const result = await client.callTool({ name: "project_task_list", arguments: { project: "matrix-os" } });
      expect(result.isError).toBe(true);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await close(); }
  });
});
