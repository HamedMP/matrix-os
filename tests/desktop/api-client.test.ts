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

  it("maps 401 to unauthorized AppError", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(401, {}));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "unauthorized" });
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

  it("treats non-JSON success bodies as server errors", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("<html>", { status: 200 }));
    const client = createApiClient({
      baseUrl: "https://x.test",
      getRuntimeSlot: () => "primary",
      fetchFn,
    });
    await expect(client.get("/api/apps")).rejects.toMatchObject({ category: "server" });
  });
});
