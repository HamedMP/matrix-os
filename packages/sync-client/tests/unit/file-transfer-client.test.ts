import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  completeRemotePaths,
  downloadRemoteFile,
  uploadLocalFile,
} from "../../src/cli/file-transfer-client.js";

describe("cli/file-transfer-client", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "matrix-transfer-client-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it("uploads a local file with auth, force, and secret query flags", async () => {
    const local = join(tempDir, "auth.json");
    await writeFile(local, '{"token":"secret"}');
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: ".codex/auth.json", size: 18 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await uploadLocalFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      local,
      ".codex/auth.json",
      { force: true, secret: true },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://gateway.example/api/files/blob?path=.codex%2Fauth.json&filename=auth.json&force=true&secret=true");
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer token");
    expect(Buffer.from(await (init?.body as Blob).arrayBuffer()).toString("utf8")).toBe('{"token":"secret"}');
  });

  it("uploads symlinked local credential files", async () => {
    const target = join(tempDir, "target-auth.json");
    const link = join(tempDir, "auth-link.json");
    await writeFile(target, '{"token":"from-symlink"}');
    await symlink(target, link);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, path: ".claude/.credentials.json", size: 24 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await uploadLocalFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      link,
      ".claude/.credentials.json",
      { secret: true },
    );

    const [, init] = fetchMock.mock.calls[0]!;
    expect(Buffer.from(await (init?.body as Blob).arrayBuffer()).toString("utf8")).toBe('{"token":"from-symlink"}');
  });

  it("sends the local filename when uploading to a Matrix-home folder", async () => {
    const local = join(tempDir, "codex-security-findings.csv");
    await writeFile(local, "finding\n");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        ok: true,
        path: "dev/matrix-os/codex-security-findings.csv",
        size: 8,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await uploadLocalFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      local,
      "~/dev/matrix-os",
    );

    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://gateway.example/api/files/blob?path=dev%2Fmatrix-os&filename=codex-security-findings.csv",
    );
    expect(result.path).toBe("dev/matrix-os/codex-security-findings.csv");
  });

  it("rejects missing local files and local directories before upload", async () => {
    await expect(
      uploadLocalFile(
        { gatewayUrl: "https://gateway.example", token: "token" },
        join(tempDir, "missing.txt"),
        "missing.txt",
      ),
    ).rejects.toMatchObject({ code: "local_file_not_found" });

    await expect(
      uploadLocalFile(
        { gatewayUrl: "https://gateway.example", token: "token" },
        tempDir,
        "directory",
      ),
    ).rejects.toMatchObject({ code: "local_path_not_file" });
  });

  it("downloads atomically and refuses to replace local symlinks", async () => {
    const intermediate = join(tempDir, "downloads");
    const parent = join(intermediate, "nested");
    const destination = join(parent, "downloaded.txt");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("downloaded", { status: 200 }));

    await downloadRemoteFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      "notes/today.md",
      destination,
    );

    expect(await readFile(destination, "utf8")).toBe("downloaded");
    expect((await stat(intermediate)).mode & 0o777).toBe(0o755);
    expect((await stat(parent)).mode & 0o777).toBe(0o755);
    expect((await stat(destination)).mode & 0o777).toBe(0o644);

    const target = join(tempDir, "target.txt");
    const link = join(tempDir, "link.txt");
    await writeFile(target, "target");
    await symlink(target, link);

    await expect(
      downloadRemoteFile(
        { gatewayUrl: "https://gateway.example", token: "token" },
        "notes/today.md",
        link,
      ),
    ).rejects.toThrow(/symlink/i);
  });

  it("downloads secret files with owner-only permissions", async () => {
    const destination = join(tempDir, "secret.json");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret", { status: 200 }));

    await downloadRemoteFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      ".codex/auth.json",
      destination,
      { secret: true },
    );

    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });

  it("reports missing remote files clearly on download", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not found", { status: 404 }));
    const destination = join(tempDir, "new-parent/missing.txt");

    await expect(
      downloadRemoteFile(
        { gatewayUrl: "https://gateway.example", token: "token" },
        "missing.txt",
        destination,
      ),
    ).rejects.toMatchObject({ code: "remote_file_not_found" });
    await expect(stat(join(tempDir, "new-parent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports invalid Matrix destinations clearly on upload", async () => {
    const local = join(tempDir, "report.csv");
    await writeFile(local, "finding\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid_path" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      uploadLocalFile(
        { gatewayUrl: "https://gateway.example", token: "token" },
        local,
        "../outside/report.csv",
      ),
    ).rejects.toMatchObject({
      code: "invalid_remote_path",
      message: expect.stringMatching(/Matrix home/i),
    });
  });

  it("keeps status-based transfer errors for older gateways", async () => {
    const local = join(tempDir, "report.csv");
    await writeFile(local, "finding\n");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("conflict", { status: 409 }),
    );

    await expect(uploadLocalFile(
      { gatewayUrl: "https://gateway.example", token: "token" },
      local,
      "~/report.csv",
    )).rejects.toMatchObject({ code: "remote_file_exists" });
  });

  it("completes Matrix directories while preserving the typed home prefix", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({
        path: ".",
        entries: [
          { name: "dev", type: "directory" },
          { name: "documents", type: "directory" },
          { name: "README.md", type: "file" },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(completeRemotePaths(
      { gatewayUrl: "https://gateway.example", token: "token" },
      "~/de",
    )).resolves.toEqual(["~/dev/"]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://gateway.example/api/files/list?path=.",
    );
  });
});
