import { lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupChatAttachmentFiles,
  createChatAttachmentCleanupLifecycle,
} from "../../packages/gateway/src/chat/attachment-cleanup.js";

describe("temporary Chat attachment cleanup", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("enforces both TTL and count caps without following symlinked entries", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachments-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachment-outside-"));
    cleanupPaths.push(homePath, outsidePath);
    const directory = join(homePath, "temporary", "desktop-chat");
    await mkdir(directory, { recursive: true });
    const oldPath = join(directory, "old.txt");
    const newestPath = join(directory, "newest.txt");
    const overCountPath = join(directory, "over-count.txt");
    const outsideFile = join(outsidePath, "outside.txt");
    await writeFile(oldPath, "old");
    await writeFile(overCountPath, "over");
    await writeFile(newestPath, "new");
    await writeFile(outsideFile, "outside");
    await symlink(outsideFile, join(directory, "linked.txt"));
    await utimes(oldPath, new Date(1_000), new Date(1_000));
    await utimes(overCountPath, new Date(9_000), new Date(9_000));
    await utimes(newestPath, new Date(10_000), new Date(10_000));

    await expect(cleanupChatAttachmentFiles(homePath, {
      ttlMs: 5_000,
      maxFiles: 1,
    }, 10_001)).resolves.toBe(2);

    await expect(lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(overCountPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(newestPath, "utf8")).resolves.toBe("new");
    await expect(lstat(join(directory, "linked.txt"))).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    await expect(readFile(outsideFile, "utf8")).resolves.toBe("outside");
  });

  it("refuses to traverse a symlinked attachment directory", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachments-"));
    const outsidePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachment-outside-"));
    cleanupPaths.push(homePath, outsidePath);
    await mkdir(join(homePath, "temporary"), { recursive: true });
    await writeFile(join(outsidePath, "outside.txt"), "outside");
    await symlink(outsidePath, join(homePath, "temporary", "desktop-chat"));

    await expect(cleanupChatAttachmentFiles(homePath, { ttlMs: 0, maxFiles: 0 }, Date.now()))
      .resolves.toBe(0);
    await expect(lstat(join(homePath, "temporary", "desktop-chat")))
      .resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    await expect(readFile(join(outsidePath, "outside.txt"), "utf8")).resolves.toBe("outside");
  });

  it("deterministically retains only the newest bounded candidate set", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachments-"));
    cleanupPaths.push(homePath);
    const directory = join(homePath, "temporary", "desktop-chat");
    await mkdir(directory, { recursive: true });
    for (const name of ["delta.txt", "alpha.txt", "charlie.txt", "bravo.txt"]) {
      const path = join(directory, name);
      await writeFile(path, name);
      await utimes(path, new Date(10_000), new Date(10_000));
    }

    await expect(cleanupChatAttachmentFiles(homePath, { ttlMs: 10_000, maxFiles: 2 }, 10_001))
      .resolves.toBe(2);
    await expect(readFile(join(directory, "alpha.txt"), "utf8")).resolves.toBe("alpha.txt");
    await expect(readFile(join(directory, "bravo.txt"), "utf8")).resolves.toBe("bravo.txt");
    await expect(lstat(join(directory, "charlie.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(directory, "delta.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs recurring cleanup without overlap and clears its timer on close", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "matrix-chat-attachments-"));
    cleanupPaths.push(homePath);
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((callback: () => void) => {
      scheduled = callback;
      return "chat-cleanup-timer";
    });
    const cancel = vi.fn();
    const lifecycle = createChatAttachmentCleanupLifecycle({
      homePath,
      policy: { ttlMs: 0, maxFiles: 0 },
      intervalMs: 100,
      schedule,
      cancel,
    });

    const initialRun = lifecycle.runNow();
    expect(lifecycle.runNow()).toBe(initialRun);
    await initialRun;
    const attachmentPath = join(homePath, "temporary", "desktop-chat", "later.txt");
    await writeFile(attachmentPath, "later");
    scheduled?.();
    await lifecycle.waitForIdle();
    await expect(lstat(attachmentPath)).rejects.toMatchObject({ code: "ENOENT" });

    lifecycle.close();
    expect(cancel).toHaveBeenCalledWith("chat-cleanup-timer");
    expect(schedule).toHaveBeenCalledOnce();
  });

  it("starts recurring cleanup only after gateway startup and cancels it before awaited shutdown", async () => {
    const source = await readFile(new URL(
      "../../packages/gateway/src/server.ts",
      import.meta.url,
    ), "utf8");
    const serverStart = source.indexOf("const server = serve(");
    const cleanupStart = source.indexOf("createChatAttachmentCleanupLifecycle({");
    const initialSweep = source.indexOf("void chatAttachmentCleanup.runNow()", cleanupStart);
    const closeStart = source.indexOf("async close()", cleanupStart);
    const cleanupClose = source.indexOf("chatAttachmentCleanup.close();", closeStart);
    const firstAwaitedShutdown = source.indexOf("await hookRunner.fireVoidHook", closeStart);

    expect(serverStart).toBeGreaterThan(-1);
    expect(cleanupStart).toBeGreaterThan(serverStart);
    expect(initialSweep).toBeGreaterThan(cleanupStart);
    expect(cleanupClose).toBeGreaterThan(closeStart);
    expect(cleanupClose).toBeLessThan(firstAwaitedShutdown);
  });
});
