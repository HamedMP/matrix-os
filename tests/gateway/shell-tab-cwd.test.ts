import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect, vi } from "vitest";
import { createZellijAdapter } from "../../packages/gateway/src/shell/zellij.js";
import { createShellRoutes } from "../../packages/gateway/src/shell/routes.js";

it("resolves tab cwd within Matrix home through the real route and adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "matrix-tab-cwd-"));
  try {
    const homePath = join(root, "home");
    await mkdir(join(homePath, "projects/repo"), { recursive: true });
    await mkdir(join(root, "outside"));
    await symlink(join(root, "outside"), join(homePath, "escape"));
    const execFile = vi.fn((_file, _args, _opts, cb) => {
      cb(null, "41\n", "");
      return new EventEmitter();
    });
    const app = createShellRoutes({
      homePath,
      registry: { list: vi.fn(), create: vi.fn(), delete: vi.fn() },
      workspace: createZellijAdapter({ homePath, manageConfig: false, execFile, spawn: vi.fn() }),
    });
    const createTab = (cwd?: string) => app.request("/sessions/main/tabs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "tests", ...(cwd === undefined ? {} : { cwd }) }),
    });
    for (const cwd of ["projects/repo", "~/projects/repo", undefined]) {
      expect((await createTab(cwd)).status).toBe(200);
      expect(execFile.mock.lastCall?.[1]).toEqual([
        "--session", "main", "action", "new-tab", "--name", "tests", "--cwd",
        await realpath(cwd === undefined ? homePath : join(homePath, "projects/repo")),
      ]);
    }
    execFile.mockClear();
    for (const cwd of ["escape", "missing", "../outside"]) {
      expect((await createTab(cwd)).status).toBe(400);
    }
    expect(execFile).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
