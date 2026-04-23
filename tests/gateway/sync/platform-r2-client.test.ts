import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPlatformR2Client } from "../../../packages/gateway/src/sync/platform-r2-client.js";

describe("platform R2 client", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts presign requests to the platform internal sync route with bearer auth", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ url: "https://platform.example/presigned-put" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createPlatformR2Client({
      baseUrl: "http://distro-platform-1:9000",
      handle: "alice",
      token: "upgrade-token",
    });

    const url = await client.getPresignedPutUrl("matrixos-sync/user_alice/files/test.txt", 123);

    expect(url).toBe("https://platform.example/presigned-put");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe("http://distro-platform-1:9000/internal/containers/alice/sync/presign/put");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).toBeInstanceOf(Headers);
    const headers = init?.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer upgrade-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(timeoutSpy).toHaveBeenLastCalledWith(10_000);
    expect(init?.body).toBe(
      JSON.stringify({
        key: "matrixos-sync/user_alice/files/test.txt",
        size: 123,
        expiresIn: undefined,
      }),
    );
  });

  it("maps 404 object reads to NoSuchKey", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    const client = createPlatformR2Client({
      baseUrl: "http://distro-platform-1:9000",
      handle: "alice",
      token: "upgrade-token",
    });

    await expect(
      client.getObject("matrixos-sync/user_alice/manifest.json"),
    ).rejects.toMatchObject({ name: "NoSuchKey" });
  });

  it("writes objects through the platform internal sync route", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ etag: '"etag-123"' }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createPlatformR2Client({
      baseUrl: "http://distro-platform-1:9000",
      handle: "alice",
      token: "upgrade-token",
    });

    const result = await client.putObject(
      "matrixos-sync/user_alice/manifest.json",
      new Uint8Array([1, 2, 3]),
    );

    expect(result).toEqual({ etag: '"etag-123"' });
    const [requestUrl, init] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe(
      "http://distro-platform-1:9000/internal/containers/alice/sync/object?key=matrixos-sync%2Fuser_alice%2Fmanifest.json",
    );
    expect(init?.method).toBe("PUT");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
  });
});
