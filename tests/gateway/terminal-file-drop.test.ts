import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalWorkspaceRoutes } from "../../packages/gateway/src/shell/workspace-routes";

const workspaceId = `tws_${"a".repeat(32)}`;
const tabId = `tt_${"b".repeat(32)}`;
const path = `/api/terminal/workspaces/${workspaceId}/tabs/${tabId}/paste-assets`;
let homePath: string;
let app: Hono;
let ownerId: string;
let listWorkspaces: ReturnType<typeof vi.fn>;

function upload(name: string, mimeType: string, bytes: Buffer, kind: string | null = "file") {
  return app.request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(kind === null ? {} : { kind }), assets: [{ name, mimeType, dataBase64: bytes.toString("base64") }] }),
  });
}

describe("Terminal ordinary file uploads", () => {
  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-file-drop-"));
    ownerId = "owner";
    listWorkspaces = vi.fn(async () => [{
      id: workspaceId, scope: "project", projectId: "matrix-os", tabs: [{ id: tabId, cwd: "projects/matrix-os", accessScope: "owner" }],
    }]);
    app = new Hono().route("/api/terminal", createTerminalWorkspaceRoutes({
      homePath, getPrincipal: () => ({ userId: ownerId, source: "jwt" }), terminalOwnerIds: ["owner"],
      runtime: { listWorkspaces, ensureWorkspace: vi.fn(), createTab: vi.fn(), deletionImpact: vi.fn(), deleteWorkspace: vi.fn() } as never,
    }));
  });
  afterEach(async () => { await rm(homePath, { recursive: true, force: true }); });

  it.each([
    ["brief.pdf", "application/pdf", Buffer.from("%PDF-1.7")],
    ["说明.txt", "text/plain", Buffer.from("design notes λ")],
    ["archive.zip", "application/zip", Buffer.from([0x50, 0x4b, 3, 4])],
    ["unknown.bin", "application/octet-stream", Buffer.from([0, 255, 2])],
    ["empty.txt", "text/plain", Buffer.alloc(0)],
  ])("preserves %s bytes and extension in the runtime", async (name, type, bytes) => {
    const response = await upload(name, type, bytes);
    expect(response.status).toBe(200);
    const { assets } = await response.json() as { assets: Array<{ path: string; terminalPath: string; size: number; mimeType: string }> };
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    expect(asset.path).toMatch(/^temporary\/terminal-pastes\/\d{4}-\d{2}-\d{2}\/\d+-[a-f0-9-]+\.[a-z]+$/);
    expect(asset.path.endsWith(name.slice(name.lastIndexOf(".")))).toBe(true);
    expect(asset.terminalPath).toBe(join(homePath, asset.path));
    expect(asset.size).toBe(bytes.byteLength);
    expect(asset.mimeType).toBe(type);
    expect(await readFile(asset.terminalPath)).toEqual(bytes);
  });

  it("keeps the default clipboard-image request strict", async () => {
    const response = await upload("notes.txt", "text/plain", Buffer.from("notes"), null);
    expect(response.status).toBe(400);
    expect(await readdir(homePath)).toEqual([]);
  });

  it.each(["../secret.txt", "a/b.txt", "a\\b.txt", ".."])("rejects unsafe file name %s", async (name) => {
    expect((await upload(name, "text/plain", Buffer.from("x"))).status).toBe(400);
    expect(await readdir(homePath)).toEqual([]);
  });

  it("enforces owner access before storing file bytes", async () => {
    ownerId = "other";
    expect((await upload("notes.txt", "text/plain", Buffer.from("x"))).status).toBe(404);
    expect(listWorkspaces).not.toHaveBeenCalled();
    expect(await readdir(homePath)).toEqual([]);
  });

  it("rejects a file above 10 MiB before creating output", async () => {
    expect((await upload("big.bin", "application/octet-stream", Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect(await readdir(homePath)).toEqual([]);
  });
});
