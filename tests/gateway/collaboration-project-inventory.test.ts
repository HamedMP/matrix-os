import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectInventoryError,
  createProjectInventoryService,
  type ProjectInventoryResourceSource,
} from "../../packages/gateway/src/collaboration/project-inventory.js";

const OWNER_ID = "user_owner";
const PROJECT_ID = "proj_alpha";
const SECRET = "inventory-confirmation-secret-that-is-at-least-32-bytes";

interface Fixture {
  homePath: string;
  projectRoot: string;
  cleanup(): Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function fixture(): Promise<Fixture> {
  const homePath = await mkdtemp(join(tmpdir(), "matrix-project-inventory-"));
  const projectRoot = join(homePath, "projects", "alpha", "repo");
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "# Alpha\n");
  await writeFile(join(projectRoot, "src", "index.ts"), "export const alpha = true;\n");
  const cleanup = async () => rm(homePath, { recursive: true, force: true });
  cleanups.push(cleanup);
  return { homePath, projectRoot, cleanup };
}

function source(
  projectRoot: string,
  overrides: Partial<ProjectInventoryResourceSource> = {},
): ProjectInventoryResourceSource {
  return {
    async getProject(projectId) {
      return projectId === PROJECT_ID
        ? { id: PROJECT_ID, ownerId: OWNER_ID, rootPath: projectRoot, revision: 7 }
        : null;
    },
    async listChats() {
      return [
        { id: "chat_owned", revision: "12", compatibility: "ready" },
        { id: "chat_external", revision: "4", ownership: "external" },
      ];
    },
    async listApps() {
      return [
        { id: "app_board", revision: "3", compatibility: "ready" },
        { id: "app_unsafe", revision: "1", compatibility: "blocked", blocker: "role_enforcement_unavailable" },
      ];
    },
    async getLayout() {
      return { id: "layout", revision: "9", compatibility: "ready" };
    },
    async listTerminals() {
      return [
        {
          id: "terminal_owned",
          revision: "5",
          incarnation: "terminal_11111111111111111111111111111111",
          compatibility: "ready",
        },
        { id: "terminal_linked", revision: "2", ownership: "external" },
      ];
    },
    ...overrides,
  };
}

function service(input: {
  homePath: string;
  projectRoot: string;
  source?: ProjectInventoryResourceSource;
  now?: () => Date;
}) {
  return createProjectInventoryService({
    homePath: input.homePath,
    source: input.source ?? source(input.projectRoot),
    confirmationSecret: SECRET,
    now: input.now,
  });
}

const membershipEffects = [
  { actorId: "user_editor", role: "editor" as const, effect: "join_project" as const },
  { actorId: "user_item_only", role: "viewer" as const, effect: "retain_item_only" as const },
];

describe("project collaboration inventory", () => {
  it("derives one deterministic complete inventory and separates external references", async () => {
    const test = await fixture();
    const inventory = await service(test).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });

    expect(inventory.projectRevision).toBe(7);
    expect(inventory.ownedItems.map((item) => [item.kind, item.id])).toEqual([
      ["app", "app_board"],
      ["app", "app_unsafe"],
      ["chat", "chat_owned"],
      ["file", "README.md"],
      ["file", "src/index.ts"],
      ["layout", "layout"],
      ["terminal", "terminal_owned"],
    ]);
    expect(inventory.externalReferences.map((item) => [item.kind, item.id])).toEqual([
      ["chat", "chat_external"],
      ["terminal", "terminal_linked"],
    ]);
    expect(inventory.blockers).toEqual([{
      kind: "app",
      id: "app_unsafe",
      code: "role_enforcement_unavailable",
    }]);
    expect(inventory.inventoryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.membershipHash).toMatch(/^[a-f0-9]{64}$/);
    expect(inventory.inventoryToken.split(".")).toHaveLength(2);

    const repeated = await service(test).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects: [...membershipEffects].reverse(),
    });
    expect(repeated.inventoryHash).toBe(inventory.inventoryHash);
    expect(repeated.membershipHash).toBe(inventory.membershipHash);
  });

  it("binds the expiring confirmation to owner, project, revision, inventory, and membership", async () => {
    const test = await fixture();
    let now = new Date("2026-08-10T12:00:00.000Z");
    const inventory = await service({ ...test, now: () => now }).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });
    const verifier = service({ ...test, now: () => now });

    await expect(verifier.verifyConfirmation({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      expectedRevision: inventory.projectRevision,
      inventoryHash: inventory.inventoryHash,
      membershipHash: inventory.membershipHash,
      inventoryToken: inventory.inventoryToken,
    })).resolves.toMatchObject({ ownerId: OWNER_ID, projectId: PROJECT_ID });

    await expect(verifier.verifyConfirmation({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      expectedRevision: inventory.projectRevision,
      inventoryHash: inventory.inventoryHash,
      membershipHash: "f".repeat(64),
      inventoryToken: inventory.inventoryToken,
    })).rejects.toMatchObject({ code: "invalid_confirmation" });

    now = new Date("2026-08-10T12:10:00.001Z");
    await expect(verifier.verifyConfirmation({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      expectedRevision: inventory.projectRevision,
      inventoryHash: inventory.inventoryHash,
      membershipHash: inventory.membershipHash,
      inventoryToken: inventory.inventoryToken,
    })).rejects.toMatchObject({ code: "invalid_confirmation" });
  });

  it("changes the fingerprint when an owned file changes", async () => {
    const test = await fixture();
    const inventory = await service(test).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });
    await writeFile(join(test.projectRoot, "README.md"), "# Alpha changed\n");

    const changed = await service(test).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });
    expect(changed.inventoryHash).not.toBe(inventory.inventoryHash);
  });

  it("lists symlinks as blocking owned entries without following them", async () => {
    const test = await fixture();
    const outside = join(test.homePath, "private.txt");
    await writeFile(outside, "owner private\n");
    await symlink(outside, join(test.projectRoot, "linked-private.txt"));

    const inventory = await service(test).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });
    expect(inventory.ownedItems).toContainEqual(expect.objectContaining({
      kind: "file",
      id: "linked-private.txt",
      compatibility: "blocked",
      blocker: "symlink_unsupported",
    }));
    expect(inventory.blockers).toContainEqual({
      kind: "file",
      id: "linked-private.txt",
      code: "symlink_unsupported",
    });
  });

  it("fails closed for roots outside the owner home or changed while inventory is collected", async () => {
    const test = await fixture();
    const outsideRoot = await mkdtemp(join(tmpdir(), "matrix-project-outside-"));
    cleanups.push(async () => rm(outsideRoot, { recursive: true, force: true }));
    const traversalRoot = join(test.projectRoot, "..", "..", "..", "..", basename(outsideRoot));
    await expect(service({
      ...test,
      source: source(traversalRoot),
    }).preview({ ownerId: OWNER_ID, projectId: PROJECT_ID, membershipEffects }))
      .rejects.toBeInstanceOf(ProjectInventoryError);

    let releaseResources: (() => void) | undefined;
    const resourcesBlocked = new Promise<void>((resolve) => { releaseResources = resolve; });
    let resourcesStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { resourcesStarted = resolve; });
    const movingSource = source(test.projectRoot, {
      async listChats() {
        resourcesStarted?.();
        await resourcesBlocked;
        return [];
      },
    });
    const pending = service({ ...test, source: movingSource }).preview({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      membershipEffects,
    });
    await started;
    const moved = `${test.projectRoot}-moved`;
    await rename(test.projectRoot, moved);
    await mkdir(test.projectRoot, { recursive: true });
    releaseResources?.();

    await expect(pending).rejects.toMatchObject({ code: "project_changed" });
  });
});
