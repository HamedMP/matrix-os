import { expect, it, vi } from "vitest";
import { unzipSync } from "fflate";
import { createDirectoryArchive } from "@desktop/renderer/src/features/files/directory-download";
it("downloads a folder as a ZIP with nested files and empty folders", async () => {
  const list = vi.fn(async (path: string) => path === "notes" ? [{ path: "notes/readme.md", kind: "file" as const }, { path: "notes/empty", kind: "directory" as const }] : []);
  const read = vi.fn(async () => new Uint8Array([65, 66]));
  const result = await createDirectoryArchive("notes", { list, read }, new AbortController().signal);
  const zip = unzipSync(result.bytes);
  expect(result.name).toBe("notes.zip");
  expect(zip["notes/readme.md"]).toEqual(new Uint8Array([65, 66]));
  expect(zip["notes/empty/"]).toBeDefined();
});
it("rejects escaping, duplicate and unsupported entries without reading them", async () => {
  for (const entries of [[{ path: "elsewhere/secret", kind: "file" }], [{ path: "notes/../secret", kind: "file" }], [{ path: "notes/link", kind: "symlink" }]]) {
    const read = vi.fn();
    await expect(createDirectoryArchive("notes", { list: async () => entries as never, read }, new AbortController().signal)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
  }
});
it("enforces a shared archive byte limit and cancellation", async () => {
  const read = vi.fn(async () => new Uint8Array(51 * 1024 * 1024));
  await expect(createDirectoryArchive("notes", { list: async () => [{ path: "notes/large", kind: "file" }], read }, new AbortController().signal)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(createDirectoryArchive("notes", { list: vi.fn(), read: vi.fn() }, controller.signal)).rejects.toThrow();
});
it("cancels a pending directory read even when its transport ignores abort", async () => {
  const controller = new AbortController();
  const pending = createDirectoryArchive("notes", { list: () => new Promise(() => {}), read: vi.fn() }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

// Exercise the archive-specific listing through the real authenticated service/router.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createFilePreviewService } from "../../packages/gateway/src/file-preview-service";
import { createFilePreviewRoutes } from "../../packages/gateway/src/file-preview-routes";
const fixtures: string[] = [];
afterEach(async () => { for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true }); });
async function archiveServer() {
  const root = await mkdtemp(join(tmpdir(), "matrix-archive-")); fixtures.push(root);
  const home = join(root, "home"), project = join(root, "project"), worktree = join(root, "worktree");
  await Promise.all([home, project, worktree].map((path) => mkdir(join(path, "notes"), { recursive: true })));
  const service = createFilePreviewService({ homePath: home, canAccessHome: (principal) => principal.userId === "owner",
    resolveProjectRoot: async (principal, ref) => principal.userId === "owner" && ref.projectId === "demo" ? ref.worktreeId ? worktree : project : null });
  const app = createFilePreviewRoutes({ service, getPrincipal: (c) => ({ userId: c.req.header("authorization") === "owner" ? "owner" : "other", source: "jwt" }) });
  return { app, home, project, worktree };
}
it.each(["home", "project", "worktree"])("includes hidden files in complete %s folder listings", async (kind) => {
  const fixture = await archiveServer();
  await writeFile(join(fixture[kind as "home" | "project" | "worktree"], "notes", ".env"), "hidden=true");
  const query = `kind=${kind === "home" ? "home" : "project"}&path=notes${kind !== "home" ? "&projectId=demo" : ""}${kind === "worktree" ? "&worktreeId=wt_one" : ""}`;
  const response = await fixture.app.request(`/directory?${query}`, { headers: { authorization: "owner" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ complete: true, entries: [{ path: "notes/.env", kind: "file" }] });
});
it("fails rather than returning a partial list for 1001 entries or any symlink", async () => {
  const { app, home } = await archiveServer();
  await symlink(join(home, "notes"), join(home, "notes", "link"));
  expect((await app.request("/directory?kind=home&path=notes", { headers: { authorization: "owner" } })).status).toBe(503);
  await rm(join(home, "notes", "link"));
  for (let first = 0; first < 1001; first += 100) await Promise.all(Array.from({ length: Math.min(100, 1001 - first) }, (_, i) => writeFile(join(home, "notes", `file-${first + i}`), "x")));
  const response = await app.request("/directory?kind=home&path=notes", { headers: { authorization: "owner" } });
  expect(response.status).toBe(503);
  expect(await response.json()).not.toHaveProperty("entries");
});
it("enforces owner, worktree, denied-path and symlink-root admission for archive lists", async () => {
  const { app, home } = await archiveServer();
  expect((await app.request("/directory?kind=home&path=notes")).status).toBe(404);
  expect((await app.request("/directory?kind=project&projectId=other&path=notes", { headers: { authorization: "owner" } })).status).toBe(404);
  await mkdir(join(home, "data", "browser-profiles"), { recursive: true });
  expect((await app.request("/directory?kind=home&path=data/browser-profiles", { headers: { authorization: "owner" } })).status).toBe(404);
  await symlink(join(home, "notes"), join(home, "link"));
  expect((await app.request("/directory?kind=home&path=link", { headers: { authorization: "owner" } })).status).toBe(404);
});
