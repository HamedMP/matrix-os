import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  createStateOps,
  readJsonFile,
} from "../../packages/gateway/src/state-ops.js";

describe("state-ops", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-state-ops-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("writes JSON atomically using a same-directory temporary file", async () => {
    const target = join(homePath, "system", "sessions", "sess_1.json");

    await atomicWriteJson(target, { id: "sess_1", ok: true });

    await expect(readJsonFile(target)).resolves.toEqual({ id: "sess_1", ok: true });
    await expect(readdir(join(homePath, "system", "sessions"))).resolves.toEqual(["sess_1.json"]);
  });

  it("replays clone staging operation logs by deleting abandoned staging directories", async () => {
    const staged = join(homePath, "system", "clone-staging", "repo-abc");
    await mkdir(staged, { recursive: true });
    await writeFile(join(staged, "partial"), "partial clone");
    const ops = createStateOps({ homePath, now: () => "2026-04-26T00:00:00.000Z" });
    await ops.recordOperation({
      id: "op_1",
      type: "clone_project",
      status: "staged",
      projectSlug: "repo",
      stagingPath: staged,
    });

    const result = await ops.recoverOperations();

    expect(result.cleanedStaging).toEqual([staged]);
    await expect(stat(staged)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exports and deletes only the requested owner-scoped project data", async () => {
    await mkdir(join(homePath, "projects", "keep"), { recursive: true });
    await mkdir(join(homePath, "projects", "drop"), { recursive: true });
    await atomicWriteJson(join(homePath, "projects", "keep", "config.json"), {
      slug: "keep",
      ownerScope: { type: "user", id: "user_a" },
    });
    await atomicWriteJson(join(homePath, "projects", "drop", "config.json"), {
      slug: "drop",
      ownerScope: { type: "user", id: "user_a" },
    });
    const ops = createStateOps({ homePath });

    const manifest = await ops.exportWorkspace({ scope: "project", projectSlug: "drop", ownerScope: { type: "user", id: "user_a" } });
    expect(manifest.files).toContain("projects/drop/config.json");
    expect(manifest.files).not.toContain("projects/keep/config.json");

    await expect(ops.deleteWorkspaceData({
      scope: "project",
      projectSlug: "drop",
      ownerScope: { type: "user", id: "user_a" },
      confirmation: "delete project workspace data",
    })).resolves.toMatchObject({ ok: true });
    await expect(stat(join(homePath, "projects", "drop"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(homePath, "projects", "keep", "config.json"), "utf-8")).resolves.toContain("keep");
  });
});
