import { describe, expect, it, vi } from "vitest";
import { buildGatewayUrl, createApiClient } from "@desktop/renderer/src/lib/api";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildGatewayUrl", () => {
  it("joins base and path", () => {
    expect(buildGatewayUrl("https://app.matrix-os.com", "/api/workspace/projects", "primary")).toBe(
      "https://app.matrix-os.com/api/workspace/projects",
    );
  });

  it("appends runtime only when slot is not primary", () => {
    expect(buildGatewayUrl("https://app.matrix-os.com", "/api/apps", "vm-2")).toBe(
      "https://app.matrix-os.com/api/apps?runtime=vm-2",
    );
    expect(buildGatewayUrl("https://app.matrix-os.com", "/api/apps", "primary")).toBe(
      "https://app.matrix-os.com/api/apps",
    );
  });

  it("merges runtime with existing query params", () => {
    expect(
      buildGatewayUrl("https://app.matrix-os.com", "/api/projects/x/tasks?limit=50", "vm-2"),
    ).toBe("https://app.matrix-os.com/api/projects/x/tasks?limit=50&runtime=vm-2");
  });
});

describe("createApiClient", () => {
  it("can pin requests to the original runtime", async () => {
    let runtimeSlot = "computer-a";
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const client = createApiClient({
      baseUrl: "https://app.matrix-os.com",
      getRuntimeSlot: () => runtimeSlot,
      fetchFn,
    });
    const pinned = client.forRuntime(runtimeSlot);

    runtimeSlot = "computer-b";
    await pinned.post("/api/bridge/query", { action: "update" });

    expect(fetchFn).toHaveBeenCalledWith(
      "https://app.matrix-os.com/api/bridge/query?runtime=computer-a",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("fetches and parses JSON with a timeout signal", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { projects: [{ slug: "matrix-os" }] }));
    const client = createApiClient({
      baseUrl: "https://app.matrix-os.com",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    const data = await client.get<{ projects: Array<{ slug: string }> }>("/api/workspace/projects");
    expect(data.projects[0]!.slug).toBe("matrix-os");
    const [, init] = fetchFn.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("composes a caller cancellation signal with the mandatory timeout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const caller = new AbortController();
    const client = createApiClient({
      baseUrl: "https://app.matrix-os.com",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });

    await client.get("/api/apps", { signal: caller.signal });

    const [, init] = fetchFn.mock.calls[0]!;
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
    caller.abort();
    expect((init as RequestInit).signal!.aborted).toBe(true);
  });

  it("maps 401 to unauthorized AppError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "unauthorized" });
  });

  it("invokes onUnauthorized exactly once on a 401, before throwing", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
      onUnauthorized,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "unauthorized" });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("does not invoke onUnauthorized for non-401 errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
      onUnauthorized,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "server" });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("maps network failure to offline", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "offline" });
  });

  it("maps timeout aborts to timeout", async () => {
    const fetchFn = vi
      .fn()
      .mockRejectedValue(new DOMException("The operation timed out.", "TimeoutError"));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "timeout" });
  });

  it("sends JSON bodies on post/patch and parses responses", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { id: "t1", title: "Fix" }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "vm-2",
      fetchFn,
    });
    await client.post("/api/projects/p/tasks", { title: "Fix" });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://x.test/api/projects/p/tasks?runtime=vm-2");
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ title: "Fix" });
  });

  it("honors a bounded per-request timeout override", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });

    await client.post("/api/projects/clone", { url: "https://github.com/owner/repo" }, { timeoutMs: 310_000 });

    expect(timeout).toHaveBeenCalledWith(310_000);
  });

  it("honors a bounded timeout override for PUT mutations", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });

    await client.put("/api/settings/agent", { runtime: "openclaw" }, { timeoutMs: 90_000 });

    expect(timeout).toHaveBeenCalledWith(90_000);
  });

  it("uploads binary blobs with caller headers and a bounded timeout", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(201, {
      terminalPath: "/home/matrix/home/projects/paste.png",
    }));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "vm-2",
      fetchFn,
    });
    const image = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });

    await client.postBytes(
      "/api/terminal/sessions/main/paste-assets",
      image,
      { "Content-Type": "image/png", "X-Matrix-Filename": "shot.png" },
      { timeoutMs: 30_000 },
    );

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://x.test/api/terminal/sessions/main/paste-assets?runtime=vm-2");
    expect(init).toMatchObject({ method: "POST", body: image });
    expect((init as RequestInit).headers).toEqual({
      "Content-Type": "image/png",
      "X-Matrix-Filename": "shot.png",
    });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });

  it("uploads file blobs with PUT without JSON encoding", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(200, {
      ok: true,
      path: "projects/demo/readme.txt",
      size: 5,
    }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    const file = new Blob(["hello"], { type: "text/plain" });

    await client.putBytes("/api/files/blob?path=projects%2Fdemo%2Freadme.txt", file, {
      "Content-Type": "text/plain",
    });

    const [, init] = fetchFn.mock.calls[0]!;
    expect(init).toMatchObject({ method: "PUT", body: file });
    expect((init as RequestInit).headers).toEqual({ "Content-Type": "text/plain" });
  });

  it("treats non-JSON success bodies as server errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "server" });
  });

  it("fetches binary blobs through the authenticated client with a timeout signal", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } }));
    const client = createApiClient({
      baseUrl: "https://app.matrix-os.com",
      getRuntimeSlot: () => "vm-2",
      fetchFn,
    });
    const blob = await client.getBlob("/api/files/blob?path=hero.png");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBe(3);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://app.matrix-os.com/api/files/blob?path=hero.png&runtime=vm-2");
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it("maps blob 401s to unauthorized without leaking bytes", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.getBlob("/api/files/blob?path=hero.png")).rejects.toMatchObject({
      category: "unauthorized",
    });
  });

  it("fails closed when a bounded blob response exceeds the byte cap", async () => {
    // The stat that sized the file can be stale by the time the blob is read;
    // the cap must apply to the bytes actually fetched.
    const fetchFn = vi.fn().mockResolvedValue(new Response(new Uint8Array(64), { status: 200 }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(
      client.getBlob("/api/files/blob?path=hero.png", { maxBytes: 16 }),
    ).rejects.toMatchObject({ message: "file_too_large" });
  });

  it("returns bounded text within the byte cap and rejects beyond it", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("small body", { status: 200 }))
      .mockResolvedValueOnce(new Response("x".repeat(64), { status: 200 }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(
      client.getText("/api/files/blob?path=notes.md", { maxBytes: 1024 }),
    ).resolves.toBe("small body");
    await expect(
      client.getText("/api/files/blob?path=notes.md", { maxBytes: 16 }),
    ).rejects.toMatchObject({ message: "file_too_large" });
  });
});
