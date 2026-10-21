import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotWorkspace, resolveBotWorkspaceRoot } from "../../../packages/gateway/src/chat/bot-workspace-root.js";
import { ChatExecutionRootError, createChatExecutionRootResolver } from "../../../packages/gateway/src/chat/execution-root.js";

const owner = { type: "personal" as const, ownerId: "user_owner" };
const BOT = "bot_0123456789abcdef";
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "bot-workspace-home-"));
  homes.push(path);
  return path;
}

describe("bot workspace roots", () => {
  it("resolves ~/bots/<botId> with a stable device/inode fingerprint", async () => {
    const homePath = await home();
    const created = await createBotWorkspace({ homePath, botId: BOT });
    expect(created).toBe(join(homePath, "bots", BOT));
    const ref = { kind: "bot_workspace" as const, botId: BOT };
    const first = await resolveBotWorkspaceRoot({ homePath, owner, ref });
    expect(first).toMatchObject({ ref, primaryWorkspaceRoot: created });
    expect(first.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toHaveProperty("projectSlug");
    await expect(resolveBotWorkspaceRoot({ homePath, owner, ref })).resolves.toMatchObject({ fingerprint: first.fingerprint });
    // Another owner's view of the same directory never shares the fingerprint.
    const other = await resolveBotWorkspaceRoot({ homePath, owner: { type: "personal", ownerId: "user_other" }, ref });
    expect(other.fingerprint).not.toBe(first.fingerprint);
    await expect(createBotWorkspace({ homePath, botId: BOT })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("revalidates through the resolver: replaced is root_changed, missing or linked is invalid_root", async () => {
    const homePath = await home();
    await createBotWorkspace({ homePath, botId: BOT });
    const getProjectById = vi.fn();
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: { getProjectById, resolveProjectWorkingDirectory: vi.fn() },
      worktrees: { getWorktree: vi.fn() },
    });
    const ref = { kind: "bot_workspace" as const, botId: BOT };
    const resolved = await resolver.resolve(owner, ref);
    await expect(resolver.revalidate(owner, resolved)).resolves.toMatchObject({ fingerprint: resolved.fingerprint });

    // Swapped for a new directory at the same path.
    await rename(join(homePath, "bots", BOT), join(homePath, "bots", "moved"));
    await mkdir(join(homePath, "bots", BOT));
    await expect(resolver.revalidate(owner, resolved)).rejects.toEqual(new ChatExecutionRootError("root_changed"));

    // Replaced by a link to somewhere else.
    await rm(join(homePath, "bots", BOT), { recursive: true });
    await symlink(join(homePath, "bots", "moved"), join(homePath, "bots", BOT));
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    await rm(join(homePath, "bots", BOT));
    await expect(resolver.resolve(owner, ref)).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    expect(getProjectById).not.toHaveBeenCalled();
  });

  it("refuses organization owners, malformed bot IDs, and a linked bots directory", async () => {
    const homePath = await home();
    await createBotWorkspace({ homePath, botId: BOT });
    const ref = { kind: "bot_workspace" as const, botId: BOT };
    await expect(resolveBotWorkspaceRoot({ homePath, owner: { type: "organization", ownerId: "org_1" }, ref }))
      .rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    await expect(resolveBotWorkspaceRoot({ homePath, owner, ref: { kind: "bot_workspace", botId: "bot_../../etc" } }))
      .rejects.toEqual(new ChatExecutionRootError("invalid_root"));
    const elsewhere = await home();
    await rename(join(homePath, "bots"), join(elsewhere, "bots"));
    await symlink(join(elsewhere, "bots"), join(homePath, "bots"));
    await expect(resolveBotWorkspaceRoot({ homePath, owner, ref })).rejects.toEqual(new ChatExecutionRootError("invalid_root"));
  });
});
