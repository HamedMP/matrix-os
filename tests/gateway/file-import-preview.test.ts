import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { registerFileRoutes } from "../../packages/gateway/src/server/file-routes.js";

describe("selected import preview wiring", () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), "matrix-import-preview-")); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  function app() {
    const app = new Hono();
    app.use("*", authMiddleware("long-owner-runtime-token"));
    registerFileRoutes(app, { homePath: home, getPrincipal: () => ({ userId: "owner", source: "configured-container" }) });
    return app;
  }
  const auth = { Authorization: "Bearer long-owner-runtime-token" };
  it("reads an uploaded owner export through authenticated Files routes without changing it", async () => {
    const routes = app();
    const data = "Date,Amount\n2026-10-01,-3";
    expect((await routes.request("/api/files/blob?path=bank.csv", { method: "PUT", headers: auth, body: data })).status).toBe(200);
    const preview = await routes.request("/api/files/import-preview?path=bank.csv", { headers: auth });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toEqual({ kind: "table", columns: ["Date", "Amount"], rows: [["2026-10-01", "-3"]], truncated: false });
    expect(preview.headers.get("cache-control")).toBe("private, no-store");
    expect((await routes.request("/api/files/import-preview?path=bank.csv")).status).toBe(401);
  });
  it("blocks traversal, symlinks, unknown formats, oversize files and malformed data", async () => {
    const routes = app();
    await writeFile(join(home, "large.csv"), "x".repeat(512 * 1024 + 1));
    await writeFile(join(home, "bad.csv"), 'A\n"unfinished');
    await writeFile(join(home, "notes.txt"), "notes");
    await symlink("/etc/passwd", join(home, "secret.csv"));
    for (const path of ["../secret.csv", "secret.csv", "notes.txt", "large.csv", "bad.csv"]) {
      const response = await routes.request(`/api/files/import-preview?path=${encodeURIComponent(path)}`, { headers: auth });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain(home);
    }
  });
});
