import { describe, expect, it, vi } from "vitest";
import { createMcpGatewayClient } from "../../src/mcp/clients.js";
import type { MatrixMcpRuntime } from "../../src/mcp/profile-context.js";

const runtime: MatrixMcpRuntime = {
  computer: {
    handle: "neo-review",
    runtimeSlot: "review",
    label: "Additional Computer",
    availability: "available",
    kind: "customer",
    versionLabel: "stable",
    gatewayPath: "/vm/neo-review?runtime=review",
    capabilities: ["terminal"],
  },
  gatewayUrl: "https://app.matrix-os.com/vm/neo-review?runtime=review",
  token: "scoped-token",
};

describe("Matrix MCP gateway client", () => {
  it("preserves runtime routing and sends bearer auth with a timeout", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      sessions: [{ name: "main", status: "active", createdAt: "2026-09-04T00:00:00.000Z" }],
    }), { status: 200 }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.listTerminals()).resolves.toEqual([
      { name: "main", status: "active", createdAt: "2026-09-04T00:00:00.000Z" },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/neo-review/api/terminal/sessions?runtime=review",
      expect.objectContaining({
        headers: { authorization: "Bearer scoped-token" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("maps raw upstream failures to safe status codes", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ error: "postgres://secret@private-host/db" }),
      { status: 500 },
    ));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.listTerminals()).rejects.toEqual(expect.objectContaining({
      code: "request_failed",
      message: "request_failed",
    }));
  });

  it("maps aborts without exposing the thrown network message", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("private host", "TimeoutError"));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.listTerminals()).rejects.toEqual(expect.objectContaining({
      code: "request_timeout",
      message: "request_timeout",
    }));
  });

  it("rejects downloads by declared and actual size before returning bytes", async () => {
    const declaredFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("small", {
      status: 200,
      headers: { "content-length": String(1024 * 1024 + 1) },
    }));
    await expect(createMcpGatewayClient(runtime, { fetch: declaredFetcher }).downloadFile("large.bin"))
      .rejects.toMatchObject({ code: "payload_too_large" });

    const actualFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(1024 * 1024 + 1), {
      status: 200,
    }));
    await expect(createMcpGatewayClient(runtime, { fetch: actualFetcher }).downloadFile("large.bin"))
      .rejects.toMatchObject({ code: "payload_too_large" });
    expect(actualFetcher).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/neo-review/api/files/blob?runtime=review&path=large.bin",
      expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }),
    );
  });

  it("uploads bytes with explicit overwrite and secret flags", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      path: "secrets/note.txt",
      size: 5,
    }), { status: 200 }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.uploadFile("secrets/note.txt", Buffer.from("hello"), {
      overwrite: true,
      secret: true,
    })).resolves.toEqual({ ok: true, path: "secrets/note.txt", size: 5 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://app.matrix-os.com/vm/neo-review/api/files/blob?runtime=review&path=secrets%2Fnote.txt&force=true&secret=true",
    );
    expect(init).toMatchObject({
      method: "PUT",
      headers: {
        authorization: "Bearer scoped-token",
        "content-type": "application/octet-stream",
      },
    });
    expect(Buffer.from(init?.body as Uint8Array).toString()).toBe("hello");
  });

  it("uses an extended bounded timeout only for captured commands", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      stdout: "ok\n",
      stderr: "",
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 20,
    }), { status: 200 }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.runCommand({ command: ["printf", "ok\\n"], timeoutMs: 60_000 }))
      .resolves.toMatchObject({ stdout: "ok\n", exitCode: 0 });
    expect(fetcher).toHaveBeenCalledWith(
      "https://app.matrix-os.com/vm/neo-review/api/terminal/run?runtime=review",
      expect.objectContaining({ method: "POST", signal: expect.any(AbortSignal) }),
    );
  });

  it("parses the gateway's terminal creation acknowledgements", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ name: "agent-task", created: true }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tab: { id: 41, name: "tests" } }), { status: 200 }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.createTerminal({ name: "agent-task" })).resolves.toEqual({
      name: "agent-task",
      created: true,
    });
    await expect(client.createTab("agent-task", { name: "tests" })).resolves.toEqual({ id: 41, name: "tests" });
  });

  it("preserves the bounded file response media type for UTF-8 reads", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Notes\n", {
      status: 200,
      headers: { "content-type": "text/markdown; charset=utf-8" },
    }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.readFile("notes.md")).resolves.toEqual({
      content: "# Notes\n",
      size: 8,
      mediaType: "text/markdown; charset=utf-8",
    });
  });

  it("rejects command responses whose combined output exceeds the MCP limit", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      stdout: "a".repeat(600_000),
      stderr: "b".repeat(600_000),
      exitCode: 0,
      signal: null,
      timedOut: false,
      truncated: false,
      durationMs: 20,
    }), { status: 200 }));
    const client = createMcpGatewayClient(runtime, { fetch: fetcher });

    await expect(client.runCommand({ command: ["large-output"] }))
      .rejects.toMatchObject({ code: "request_failed" });
  });
});
