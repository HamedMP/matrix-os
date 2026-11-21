import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTaskSessionCredentials, TASK_SESSION_SECRET_RELATIVE_PATH,
} from "../../../packages/gateway/src/project-tasks/session-credentials.js";

const MATERIAL = {
  workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"1".repeat(32)}`, projectId: "proj_alpha", taskId: "task_one",
};
const homes: string[] = [];

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "matrix-task-credential-"));
  homes.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

// Fault detected: the shared local terminal token let any pane name another pane and act
// on that pane's board. A task tab's credential must prove the tab, project and task.
describe("task session credentials", () => {
  it("verifies its own credential and nothing derived from it", async () => {
    const credentials = createTaskSessionCredentials({ homePath: await home() });
    const token = await credentials.issue(MATERIAL);
    await expect(credentials.verify(token)).resolves.toEqual(MATERIAL);

    // Swapping any signed field (another project, task or tab) breaks the signature.
    await expect(credentials.verify(token.replace("proj_alpha", "proj_beta"))).resolves.toBeNull();
    await expect(credentials.verify(token.replace("task_one", "task_two"))).resolves.toBeNull();
    await expect(credentials.verify(token.replace(MATERIAL.tabId, `tt_${"2".repeat(32)}`))).resolves.toBeNull();
    const mac = token.slice(token.lastIndexOf(".") + 1);
    await expect(credentials.verify(`${token.slice(0, -mac.length)}${mac.slice(0, -2)}AA`)).resolves.toBeNull();
    for (const malformed of ["", "x", "mts1.a.b.c.d", `${token}.extra`, `${token}${"A".repeat(2_000)}`]) {
      await expect(credentials.verify(malformed)).resolves.toBeNull();
    }
  });

  it("refuses a credential signed with another owner's secret", async () => {
    const mine = createTaskSessionCredentials({ homePath: await home() });
    const theirs = createTaskSessionCredentials({ homePath: await home() });
    await expect(mine.verify(await theirs.issue(MATERIAL))).resolves.toBeNull();
  });

  it("keeps an owner-only secret that survives restarts and concurrent first use", async () => {
    const path = await home();
    const [first, second] = [createTaskSessionCredentials({ homePath: path }), createTaskSessionCredentials({ homePath: path })];
    const [a, b] = await Promise.all([first.issue(MATERIAL), second.issue(MATERIAL)]);
    expect(a).toBe(b);
    const info = await lstat(join(path, TASK_SESSION_SECRET_RELATIVE_PATH));
    expect(info.isFile()).toBe(true);
    expect(info.mode & 0o777).toBe(0o600);
    // A restarted gateway still accepts tabs launched before it started.
    await expect(createTaskSessionCredentials({ homePath: path }).verify(a)).resolves.toEqual(MATERIAL);
  });

  it("refuses to use a secret that is a symlink or not owner-only", async () => {
    const path = await home();
    await mkdir(join(path, ".cache", "matrix"), { recursive: true, mode: 0o700 });
    const target = join(path, "elsewhere");
    await writeFile(target, `${"f".repeat(64)}\n`, { mode: 0o600 });
    await symlink(target, join(path, TASK_SESSION_SECRET_RELATIVE_PATH));
    await expect(createTaskSessionCredentials({ homePath: path }).issue(MATERIAL)).rejects.toThrow();

    const open = await home();
    await mkdir(join(open, ".cache", "matrix"), { recursive: true, mode: 0o700 });
    await writeFile(join(open, TASK_SESSION_SECRET_RELATIVE_PATH), `${"f".repeat(64)}\n`, { mode: 0o644 });
    const credentials = createTaskSessionCredentials({ homePath: open });
    await expect(credentials.issue(MATERIAL)).rejects.toThrow();
    // An unusable secret is a server fault, not a refused caller; the file is left alone.
    await expect(credentials.verify(`mts1.${MATERIAL.workspaceId}.${MATERIAL.tabId}.proj_alpha.task_one.${"A".repeat(43)}`)).rejects.toThrow();
    expect((await readFile(join(open, TASK_SESSION_SECRET_RELATIVE_PATH), "utf8")).trim()).toBe("f".repeat(64));
  });
});
