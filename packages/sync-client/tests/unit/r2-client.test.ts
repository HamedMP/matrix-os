import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  AuthRejectedError,
  downloadFile,
  requestPresignedUrls,
} from "../../src/daemon/r2-client.js";

describe("daemon/r2-client", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "sync-r2-client-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("includes size in PUT presign requests", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          urls: [{ path: "notes/today.md", url: "https://example.test", expiresIn: 900 }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await requestPresignedUrls(
      { gatewayUrl: "https://app.matrix-os.com", token: "token" },
      [{ path: "notes/today.md", action: "put", hash: `sha256:${"a".repeat(64)}`, size: 42 }],
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      files: [
        {
          path: "notes/today.md",
          action: "put",
          hash: `sha256:${"a".repeat(64)}`,
          size: 42,
        },
      ],
    });
  });

  it("throws AuthRejectedError for 401/403 presign responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 401 }),
    );

    await expect(
      requestPresignedUrls(
        { gatewayUrl: "https://app.matrix-os.com", token: "token" },
        [{ path: "notes/today.md", action: "get" }],
      ),
    ).rejects.toBeInstanceOf(AuthRejectedError);
  });

  it("verifies download hashes before replacing the destination file", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const body = Buffer.from("tampered");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await expect(
      downloadFile(
        "https://example.test/get",
        finalPath,
        `sha256:${createHash("sha256").update("expected").digest("hex")}`,
      ),
    ).rejects.toThrow(/hash/i);

    await expect(stat(finalPath)).rejects.toThrow(/ENOENT/);
    expect(await readdir(join(tempDir, "notes")).catch(() => [])).toEqual([]);
  });

  it("writes downloads atomically through a temp file + rename", async () => {
    const finalPath = join(tempDir, "notes", "today.md");
    const body = Buffer.from("hello world");
    const hash = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 200 }),
    );

    await downloadFile("https://example.test/get", finalPath, hash);

    expect(await readFile(finalPath, "utf8")).toBe("hello world");
    expect(
      (await readdir(join(tempDir, "notes"))).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
