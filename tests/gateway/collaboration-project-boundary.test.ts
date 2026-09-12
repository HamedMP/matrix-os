import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProjectInventoryService,
  type ProjectInventoryResourceSource,
} from "../../packages/gateway/src/collaboration/project-inventory.js";

const OWNER_ID = "user_owner";
const PROJECT_ID = "proj_boundary";
const SECRET = "project-boundary-secret-that-is-at-least-32-bytes";
const membershipEffects = [{
  actorId: "user_editor",
  role: "editor" as const,
  effect: "join_project" as const,
}];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function roots() {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-project-boundary-"));
  const projectRoot = join(homePath, "projects", "boundary", "repo");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "stable.txt"), "stable\n");
  cleanups.push(async () => rm(homePath, { recursive: true, force: true }));
  return { homePath, projectRoot };
}

function source(
  projectRoot: string,
  overrides: Partial<ProjectInventoryResourceSource> = {},
): ProjectInventoryResourceSource {
  return {
    async getProject() {
      return { id: PROJECT_ID, ownerId: OWNER_ID, rootPath: projectRoot, revision: 2 };
    },
    async listChats() { return []; },
    async listApps() { return []; },
    async getLayout() { return { id: "layout", revision: "1" }; },
    async listTerminals() { return []; },
    ...overrides,
  };
}

function preview(homePath: string, resources: ProjectInventoryResourceSource) {
  return createProjectInventoryService({
    homePath,
    source: resources,
    confirmationSecret: SECRET,
  }).preview({ ownerId: OWNER_ID, projectId: PROJECT_ID, membershipEffects });
}

describe("project inventory boundary", () => {
  it("rejects a symlinked project root instead of following it", async () => {
    const test = await roots();
    const link = join(test.homePath, "projects", "linked-repo");
    await symlink(test.projectRoot, link);

    await expect(preview(test.homePath, source(link)))
      .rejects.toMatchObject({ code: "project_unavailable" });
  });

  it("detects a file write that races inventory finalization", async () => {
    const test = await roots();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let started: (() => void) | undefined;
    const reachedResources = new Promise<void>((resolve) => { started = resolve; });
    const pending = preview(test.homePath, source(test.projectRoot, {
      async listChats() {
        started?.();
        await blocked;
        return [];
      },
    }));

    await reachedResources;
    await writeFile(join(test.projectRoot, "stable.txt"), "changed during inventory\n");
    release?.();

    await expect(pending).rejects.toMatchObject({ code: "project_changed" });
  });

  it("fails closed on ambiguous duplicate owned resources", async () => {
    const test = await roots();
    await expect(preview(test.homePath, source(test.projectRoot, {
      async listChats() {
        return [
          { id: "chat_duplicate", revision: "1" },
          { id: "chat_duplicate", revision: "2" },
        ];
      },
    }))).rejects.toMatchObject({ code: "project_unavailable" });
  });

  it("blocks an owned terminal whose stable incarnation is unavailable", async () => {
    const test = await roots();
    const inventory = await preview(test.homePath, source(test.projectRoot, {
      async listTerminals() {
        return [{ id: "terminal_owned", revision: "3", compatibility: "ready" }];
      },
    }));

    expect(inventory.ownedItems).toContainEqual(expect.objectContaining({
      kind: "terminal",
      id: "terminal_owned",
      compatibility: "blocked",
      blocker: "terminal_incarnation_unavailable",
    }));
    expect(inventory.blockers).toContainEqual({
      kind: "terminal",
      id: "terminal_owned",
      code: "terminal_incarnation_unavailable",
    });
  });
});
