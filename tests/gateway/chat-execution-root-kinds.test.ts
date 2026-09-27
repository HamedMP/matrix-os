import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatExecutionRootError, createChatExecutionRootResolver } from "../../packages/gateway/src/chat/execution-root.js";

const owner = { type: "personal" as const, ownerId: "user_owner" };
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bot workspace execution roots", () => {
  it("never consult Project authority and fail closed while the workspace is missing", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-bot-root-home-"));
    roots.push(homePath);
    const getProjectById = vi.fn();
    const resolver = createChatExecutionRootResolver({
      homePath,
      projects: { getProjectById, resolveProjectWorkingDirectory: vi.fn() },
      worktrees: { getWorktree: vi.fn() },
    });

    const rejection = resolver.resolve(owner, { kind: "bot_workspace", botId: "bot_research1" });
    await expect(rejection).rejects.toBeInstanceOf(ChatExecutionRootError);
    await expect(rejection).rejects.toMatchObject({ code: "invalid_root" });
    expect(getProjectById).not.toHaveBeenCalled();
  });
});
