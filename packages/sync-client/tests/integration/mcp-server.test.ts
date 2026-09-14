import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpProfileContext, MatrixMcpRuntime } from "../../src/mcp/profile-context.js";
import { createMatrixMcpServer } from "../../src/mcp/server.js";

const computer = {
  handle: "neo-review",
  runtimeSlot: "review",
  label: "Additional Computer" as const,
  availability: "available" as const,
  kind: "customer" as const,
  versionLabel: "stable",
  gatewayPath: "/vm/neo-review?runtime=review",
  capabilities: ["terminal"],
};

const runtime: MatrixMcpRuntime = {
  computer,
  gatewayUrl: "https://app.matrix-os.com/vm/neo-review?runtime=review",
  token: "scoped-secret-token",
};

function context(): McpProfileContext {
  return {
    listComputers: vi.fn(async () => ({
      items: [computer],
      selectedSlot: null,
      hasMore: false,
      limit: 20,
    })),
    resolveRuntime: vi.fn(async (slot) => {
      if (slot !== "review") throw Object.assign(new Error("wrong computer private detail"), { code: "computer_not_found" });
      return runtime;
    }),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function connect(options: { context?: McpProfileContext; fetch?: typeof fetch } = {}) {
  const server = createMatrixMcpServer({
    context: options.context ?? context(),
    fetch: options.fetch ?? vi.fn<typeof fetch>(),
  });
  const client = new Client({ name: "matrix-remote-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function textResult(result: Awaited<ReturnType<Client["callTool"]>>) {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("Expected text result");
  return JSON.parse(content.text) as Record<string, unknown>;
}

afterEach(() => vi.restoreAllMocks());

describe("Matrix remote computer MCP server", () => {
  it("advertises the stable remote computer tool contract", async () => {
    const { client, server } = await connect();
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "list_computers",
      "run_command",
      "list_terminals",
      "create_terminal",
      "list_terminal_tabs",
      "create_terminal_tab",
      "select_terminal_tab",
      "send_terminal_input",
      "list_files",
      "read_file",
      "download_file",
      "upload_file",
      "list_chats",
      "search_chats",
      "get_chat",
    ]);
    expect(listed.tools.find((tool) => tool.name === "list_computers")?.annotations?.readOnlyHint).toBe(true);
    expect(listed.tools.find((tool) => tool.name === "run_command")?.annotations?.readOnlyHint).toBe(false);
    expect(listed.tools.find((tool) => tool.name === "send_terminal_input")?.annotations?.destructiveHint).toBe(true);

    await client.close();
    await server.close();
  });

  it("lists computers without exposing gateway routing or tokens", async () => {
    const { client, server } = await connect();
    const result = textResult(await client.callTool({ name: "list_computers", arguments: {} }));
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      ok: true,
      computers: [{ runtimeSlot: "review", handle: "neo-review", availability: "available" }],
    });
    expect(serialized).not.toContain("gatewayPath");
    expect(serialized).not.toContain("token");

    await client.close();
    await server.close();
  });

  it("runs captured argv only on the explicitly resolved computer", async () => {
    const profileContext = context();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(200, {
      stdout: "repo\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 12,
    }));
    const { client, server } = await connect({ context: profileContext, fetch: fetcher });
    const result = textResult(await client.callTool({
      name: "run_command",
      arguments: { computer: "review", command: ["basename", "/work/repo"], cwd: "projects/repo" },
    }));

    expect(profileContext.resolveRuntime).toHaveBeenCalledWith("review");
    expect(result).toMatchObject({
      ok: true,
      computer: { runtimeSlot: "review", handle: "neo-review" },
      stdout: "repo\n",
      exitCode: 0,
    });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ command: ["basename", "/work/repo"], cwd: "projects/repo" }),
    });

    await client.close();
    await server.close();
  });

  it("creates and controls persistent terminals and tabs", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({ url, method, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      if (method === "GET" && url.includes("/sessions?")) return json(200, { sessions: [{ name: "work", status: "active" }] });
      if (method === "POST" && url.includes("/sessions?") && !url.includes("/tabs")) return json(201, { name: "work", created: true });
      if (method === "GET" && url.includes("/tabs?")) return json(200, { tabs: [{ id: 11, idx: 0, name: "shell", focused: true }] });
      if (method === "POST" && url.includes("/tabs?") && !url.includes("/go")) return json(200, { tab: { id: 41, name: "tests" } });
      return json(200, { ok: true });
    });
    const { client, server } = await connect({ fetch: fetcher });

    expect(textResult(await client.callTool({ name: "list_terminals", arguments: { computer: "review" } })))
      .toMatchObject({ ok: true, terminals: [{ name: "work" }] });
    expect(textResult(await client.callTool({ name: "create_terminal", arguments: {
      computer: "review", name: "work", cwd: "projects/repo",
    } }))).toMatchObject({ ok: true, terminal: { name: "work" } });
    expect(textResult(await client.callTool({ name: "list_terminal_tabs", arguments: {
      computer: "review", terminal: "work",
    } }))).toMatchObject({ ok: true, tabs: [{ id: 11, idx: 0, name: "shell" }] });
    expect(textResult(await client.callTool({ name: "create_terminal_tab", arguments: {
      computer: "review", terminal: "work", name: "tests", cwd: "projects/repo",
    } }))).toMatchObject({ ok: true, tab: { id: 41, name: "tests" } });
    await client.callTool({ name: "select_terminal_tab", arguments: { computer: "review", terminal: "work", tabId: 41 } });
    await client.callTool({ name: "send_terminal_input", arguments: {
      computer: "review", terminal: "work", data: "bun test\n",
    } });

    expect(requests.some((request) => request.url.includes("/tabs/by-id/41/go?") && request.method === "POST")).toBe(true);
    expect(requests.some((request) => request.url.includes("/input?") && request.body === JSON.stringify({ data: "bun test\n" }))).toBe(true);

    await client.close();
    await server.close();
  });

  it("lists, reads, downloads, and uploads bounded remote file content", async () => {
    const binary = Buffer.from([0, 1, 2, 255]);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/api/files/list")) return json(200, { entries: [{ name: "note.txt", type: "file", size: 5 }] });
      if (init?.method === "PUT") return json(200, { ok: true, path: "artifacts/copy.bin", size: 4 });
      if (url.includes("note.txt")) return new Response("hello", { status: 200, headers: { "content-type": "text/plain" } });
      return new Response(binary, { status: 200, headers: { "content-type": "application/octet-stream" } });
    });
    const { client, server } = await connect({ fetch: fetcher });

    expect(textResult(await client.callTool({ name: "list_files", arguments: {
      computer: "review", path: "artifacts",
    } }))).toMatchObject({ ok: true, entries: [{ name: "note.txt" }] });
    expect(textResult(await client.callTool({ name: "read_file", arguments: {
      computer: "review", path: "artifacts/note.txt",
    } }))).toMatchObject({ ok: true, encoding: "utf8", content: "hello", size: 5 });
    expect(textResult(await client.callTool({ name: "download_file", arguments: {
      computer: "review", path: "artifacts/pixel.bin",
    } }))).toMatchObject({ ok: true, encoding: "base64", content: binary.toString("base64"), size: 4 });
    expect(textResult(await client.callTool({ name: "upload_file", arguments: {
      computer: "review",
      path: "artifacts/copy.bin",
      encoding: "base64",
      content: binary.toString("base64"),
      overwrite: true,
    } }))).toMatchObject({ ok: true, path: "artifacts/copy.bin", size: 4 });

    const upload = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    expect(Buffer.from(upload?.[1]?.body as Uint8Array)).toEqual(binary);

    await client.close();
    await server.close();
  });

  it("inspects chats through GET-only bounded requests and removes sensitive keys", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(init?.method ?? "GET").toBe("GET");
      const url = String(input);
      if (url.includes("/search")) return json(200, { items: [{ chat: { id: "chat_one", title: "Search" } }] });
      if (url.includes("/api/chats/chat_one")) return json(200, {
        record: { chat: { id: "chat_one", title: "One" }, accessToken: "never-return" },
        messages: [{ id: "msg_one", role: "user", parts: [{ type: "text", text: "hello" }] }],
      });
      return json(200, { items: [{ chat: { id: "chat_one", title: "One" } }], nextCursor: "chatcur_next" });
    });
    const { client, server } = await connect({ fetch: fetcher });

    expect(textResult(await client.callTool({ name: "list_chats", arguments: { computer: "review", limit: 20 } })))
      .toMatchObject({ ok: true, items: [{ chat: { id: "chat_one" } }] });
    expect(textResult(await client.callTool({ name: "search_chats", arguments: {
      computer: "review", query: "Search", limit: 20,
    } }))).toMatchObject({ ok: true, items: [{ chat: { title: "Search" } }] });
    const detail = textResult(await client.callTool({ name: "get_chat", arguments: {
      computer: "review", chatId: "chat_one", limit: 100,
    } }));
    expect(detail).toMatchObject({ ok: true, messages: [{ id: "msg_one" }] });
    expect(JSON.stringify(detail)).not.toContain("never-return");

    await client.close();
    await server.close();
  });

  it("returns allowlisted errors and rejects invalid input before network activity", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const { client, server } = await connect({ fetch: fetcher });

    const wrongComputer = await client.callTool({
      name: "list_files",
      arguments: { computer: "missing", path: "." },
    });
    expect(wrongComputer.isError).toBe(true);
    expect(textResult(wrongComputer)).toEqual({
      ok: false,
      error: {
        code: "computer_not_found",
        message: "That Matrix computer is not available to this account.",
        retryable: false,
      },
    });

    const invalid = await client.callTool({
      name: "run_command",
      arguments: { computer: "review", command: [], cwd: "../../etc" },
    });
    expect(invalid.isError).toBe(true);

    const invalidBase64 = await client.callTool({
      name: "upload_file",
      arguments: {
        computer: "review",
        path: "artifacts/bad.bin",
        encoding: "base64",
        content: "not-base64!",
      },
    });
    expect(invalidBase64.isError).toBe(true);
    expect(textResult(invalidBase64)).toMatchObject({ error: { code: "invalid_input" } });
    expect(fetcher).not.toHaveBeenCalled();

    await client.close();
    await server.close();
  });
});
