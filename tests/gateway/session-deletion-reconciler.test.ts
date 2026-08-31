import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconcilePendingShellSessionDeletions } from "../../packages/gateway/src/shell/session-deletion-reconciler.js";
import { TerminalWindowLayoutStore } from "../../packages/gateway/src/shell/terminal-window-layout-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pending shell session deletion reconciliation", () => {
  it("does not prevent gateway startup when pending-intent storage is unavailable", async () => {
    const lifecycle = {
      listPendingSessionDeletions: vi.fn(async () => { throw new Error("storage unavailable"); }),
      withSessionLifecycleLock: vi.fn(),
      completeSessionDeletion: vi.fn(),
    };
    const registry = { delete: vi.fn() };

    await expect(reconcilePendingShellSessionDeletions({ registry, lifecycle })).resolves.toEqual({
      completed: 0,
      failed: 1,
    });
    expect(registry.delete).not.toHaveBeenCalled();
  });

  it("finishes a durable deletion intent after a gateway restart", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-session-deletion-"));
    roots.push(homePath);
    const lifecycle = new TerminalWindowLayoutStore({ homePath });
    await lifecycle.beginSessionDeletion("pending-shell");
    const registry = {
      delete: vi.fn(async () => undefined),
    };

    const result = await reconcilePendingShellSessionDeletions({ registry, lifecycle });

    expect(result).toEqual({ completed: 1, failed: 0 });
    expect(registry.delete).toHaveBeenCalledWith("pending-shell", { force: true });
    await expect(lifecycle.listPendingSessionDeletions()).resolves.toEqual([]);
    await expect(lifecycle.listSessionTombstones()).resolves.toEqual(["pending-shell"]);
  });

  it("leaves failed cleanup pending while continuing with other intents", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-session-deletion-"));
    roots.push(homePath);
    const lifecycle = new TerminalWindowLayoutStore({ homePath });
    await lifecycle.beginSessionDeletion("broken-shell");
    await lifecycle.beginSessionDeletion("clean-shell");
    const registry = {
      delete: vi.fn(async (name: string) => {
        if (name === "broken-shell") throw new Error("runtime unavailable");
      }),
    };

    const result = await reconcilePendingShellSessionDeletions({ registry, lifecycle });

    expect(result).toEqual({ completed: 1, failed: 1 });
    await expect(lifecycle.listPendingSessionDeletions()).resolves.toEqual(["broken-shell"]);
  });
});
