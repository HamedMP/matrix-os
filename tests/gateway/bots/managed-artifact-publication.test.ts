import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotBrokerActionError } from "../../../packages/gateway/src/bots/broker-actions.js";
import type { ManagedPiRuntimeBinding } from "../../../packages/gateway/src/bots/runtime-registry.js";
import { BOT_SAVE_STAGING, createBotToolDispatcher, MANAGED_SAVE_STAGING, sweepBotWorkspaceSaves } from "../../../packages/gateway/src/bots/tool-dispatcher.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), link: vi.fn(actual.link), unlink: vi.fn(actual.unlink) };
});

let home: string;
let root: string;
const signal = new AbortController().signal;
const binding: ManagedPiRuntimeBinding = {
  kind: "managed_chat", ownerId: "user_owner_1", chatId: "chat_artifacts", runId: "run_artifacts",
  runtimeHandle: `runtime_${"a".repeat(32)}`, executionGeneration: "1", workspace: { kind: "chat_workspace" },
  rootFingerprint: "a".repeat(64), capabilities: ["artifact.write", "artifact.read"], requestClass: "interactive",
  accessSourceId: "matrix_included",
  route: { api: "anthropic-messages", modelId: "claude-sonnet-5", input: ["text"], contextWindow: 200_000, maxOutputTokens: 8_192 },
};
const write = (relPath: string, content = "complete artifact") =>
  ({ toolCallId: "call_save", capability: "artifact.write", args: { relPath, content, mimeType: "text/plain" } }) as never;
const tools = () => createBotToolDispatcher({ homePath: home, managedWorkspace: async () => root });
const staging = () => join(home, MANAGED_SAVE_STAGING);
const ioError = () => Object.assign(new Error("filesystem failure"), { code: "EIO" });

beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>("node:fs/promises");
  vi.mocked(fs.open).mockReset().mockImplementation(actual.open);
  vi.mocked(fs.link).mockReset().mockImplementation(actual.link);
  vi.mocked(fs.unlink).mockReset().mockImplementation(actual.unlink);
  home = await fs.mkdtemp(join(tmpdir(), "matrix-managed-artifacts-"));
  root = join(home, "workspace");
  await fs.mkdir(root);
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

describe("managed Chat artifact publication", () => {
  it("leaves no final artifact after an actual partial staged write fails", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let close: ReturnType<typeof vi.spyOn> | undefined;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await actual.open(...args);
      close = vi.spyOn(file, "close");
      vi.spyOn(file, "writeFile").mockImplementationOnce(async () => {
        await file.write("partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      });
      return file;
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(close).toHaveBeenCalledOnce();
    await expect(fs.lstat(join(root, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("publishes only complete synced bytes and removes the private stage", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    let synced = false;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      expect(String(args[0])).toMatch(new RegExp(`${MANAGED_SAVE_STAGING}/[a-f0-9-]+\\.tmp$`));
      const file = await actual.open(...args);
      const sync = file.sync.bind(file);
      vi.spyOn(file, "sync").mockImplementationOnce(async () => { await sync(); synced = true; });
      return file;
    });
    vi.mocked(fs.link).mockImplementationOnce(async (temp, target) => {
      expect(synced).toBe(true);
      await expect(fs.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(temp, "utf8")).toBe("complete artifact");
      await actual.link(temp, target);
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).resolves.toMatchObject({
      result: { ok: true, content: [{ type: "text", text: "Saved report.txt (17 bytes)." }] },
    });
    expect(await fs.readFile(join(root, "report.txt"), "utf8")).toBe("complete artifact");
    expect(await fs.readdir(staging())).toEqual([]);
    expect((await fs.stat(staging())).mode & 0o777).toBe(0o700);
  });

  it.each(["sync", "close"] as const)("cleans staging without publication when %s fails", async (method) => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const file = await actual.open(...args);
      const close = file.close.bind(file);
      vi.spyOn(file, method).mockImplementationOnce(async () => {
        if (method === "close") await close();
        throw ioError();
      });
      return file;
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toMatchObject({ code: "EIO" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(staging())).toEqual([]);
    expect(fs.link).not.toHaveBeenCalled();
  });

  it("lets one of two concurrent creates win with complete bytes", async () => {
    const dispatcher = tools();
    const outcomes = await Promise.allSettled([
      dispatcher.dispatch(binding, write("same.txt", "one".repeat(20_000)), signal),
      dispatcher.dispatch(binding, write("same.txt", "two".repeat(20_000)), signal),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected")).toMatchObject({
      reason: new BotBrokerActionError("invalid_arguments"),
    });
    expect(["one".repeat(20_000), "two".repeat(20_000)]).toContain(await fs.readFile(join(root, "same.txt"), "utf8"));
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it.each(["file", "symlink", "dangling_symlink", "directory"])("preserves an existing target %s", async (kind) => {
    const target = join(root, "owned.txt");
    const outside = join(home, "owner-original.txt");
    await fs.writeFile(outside, "owner bytes");
    if (kind === "file") await fs.writeFile(target, "original");
    else if (kind === "directory") await fs.mkdir(target);
    else await fs.symlink(kind === "symlink" ? outside : join(home, "missing.txt"), target);
    const before = await fs.lstat(target);
    await expect(tools().dispatch(binding, write("owned.txt"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    expect((await fs.lstat(target)).ino).toBe(before.ino);
    if (kind === "file") expect(await fs.readFile(target, "utf8")).toBe("original");
    expect(await fs.readFile(outside, "utf8")).toBe("owner bytes");
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("rejects symlink parents, a linked staging directory and reserved paths", async () => {
    const outside = join(home, "outside");
    await fs.mkdir(outside);
    await fs.symlink(outside, join(root, "linked"));
    await expect(tools().dispatch(binding, write("linked/report.txt"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    await fs.symlink(outside, staging());
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toEqual(new BotBrokerActionError("unavailable"));
    await expect(tools().dispatch(binding, write(`${BOT_SAVE_STAGING}/report.txt`), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it("preserves a symlink that appears while bytes are staged", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    const outside = join(home, "protected.txt");
    await fs.writeFile(outside, "owner bytes");
    vi.mocked(fs.link).mockImplementationOnce(async (temp, target) => {
      await fs.symlink(outside, target);
      await actual.link(temp, target);
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
    expect((await fs.lstat(join(root, "report.txt"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outside, "utf8")).toBe("owner bytes");
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("revalidates the admitted workspace before publication", async () => {
    const managedWorkspace = vi.fn().mockResolvedValueOnce(root).mockRejectedValueOnce(new BotBrokerActionError("stale_generation"));
    const dispatcher = createBotToolDispatcher({ homePath: home, managedWorkspace });
    await expect(dispatcher.dispatch(binding, write("report.txt"), signal)).rejects.toEqual(new BotBrokerActionError("stale_generation"));
    expect(fs.link).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it.each(["before", "after"])("preserves the final path when publication acknowledgement fails %s linking", async (when) => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.link).mockImplementationOnce(async (temp, target) => {
      if (when === "after") await actual.link(temp, target);
      throw ioError();
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toMatchObject({ code: "EIO" });
    expect(await fs.readdir(staging())).toEqual([]);
    expect(fs.link).toHaveBeenCalledOnce();
    if (when === "after") {
      expect(await fs.readFile(join(root, "report.txt"), "utf8")).toBe("complete artifact");
      await expect(tools().dispatch(binding, write("report.txt", "replay"), signal)).rejects.toEqual(new BotBrokerActionError("invalid_arguments"));
      expect(await fs.readFile(join(root, "report.txt"), "utf8")).toBe("complete artifact");
    } else expect(await fs.readdir(root)).toEqual([]);
  });

  it("preserves complete publication on directory durability failure", async () => {
    const actual = await vi.importActual<typeof fs>("node:fs/promises");
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const file = await actual.open(...args);
      if (String(args[0]) === root) vi.spyOn(file, "sync").mockRejectedValueOnce(ioError());
      return file;
    });
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toMatchObject({ code: "EIO" });
    expect(await fs.readFile(join(root, "report.txt"), "utf8")).toBe("complete artifact");
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("fails closed when the workspace cannot share the staging filesystem", async () => {
    vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("cross-device"), { code: "EXDEV" }));
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toMatchObject({ code: "EXDEV" });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("recovers crash and failed-unlink leftovers without deleting owner artifacts or following links", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(fs.unlink).mockRejectedValueOnce(ioError());
    await tools().dispatch(binding, write("report.txt"), signal);
    expect(warn).toHaveBeenCalledOnce();
    const [publishedStage] = await fs.readdir(staging());
    const staleAt = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(join(staging(), publishedStage), staleAt, staleAt);
    const crashStage = join(staging(), "00000000-0000-0000-0000-000000000000.tmp");
    await fs.writeFile(crashStage, "partial crash bytes");
    await fs.utimes(crashStage, staleAt, staleAt);
    const linkedName = "11111111-1111-1111-1111-111111111111.tmp";
    await fs.symlink(join(root, "report.txt"), join(staging(), linkedName));
    const freshName = "22222222-2222-2222-2222-222222222222.tmp";
    await fs.writeFile(join(staging(), freshName), "in progress");
    await fs.writeFile(join(staging(), "owner-file.txt"), "keep");
    // No bots directory exists: the startup sweep still reaches all managed stages.
    await sweepBotWorkspaceSaves(home);
    expect((await fs.readdir(staging())).sort()).toEqual([linkedName, freshName, "owner-file.txt"]);
    expect(await fs.readFile(join(root, "report.txt"), "utf8")).toBe("complete artifact");
    expect((await fs.stat(join(root, "report.txt"))).nlink).toBe(1);
  });

  it("bounds each recurring cleanup pass and eventually visits all managed stages", async () => {
    await fs.mkdir(staging(), { mode: 0o700 });
    const staleAt = new Date(Date.now() - 60 * 60_000);
    for (let index = 0; index < 257; index += 1) {
      const path = join(staging(), `00000000-0000-0000-0000-${String(index).padStart(12, "0")}.tmp`);
      await fs.writeFile(path, "crash bytes");
      await fs.utimes(path, staleAt, staleAt);
    }
    await sweepBotWorkspaceSaves(home);
    expect(await fs.readdir(staging())).toHaveLength(1);
    await sweepBotWorkspaceSaves(home);
    expect(await fs.readdir(staging())).toEqual([]);
  });

  it("never sweeps a staging symlink into another directory", async () => {
    const outside = join(home, "outside");
    await fs.mkdir(outside);
    const path = join(outside, "00000000-0000-0000-0000-000000000000.tmp");
    await fs.writeFile(path, "owner bytes");
    const staleAt = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(path, staleAt, staleAt);
    await fs.symlink(outside, staging());
    await sweepBotWorkspaceSaves(home);
    expect(await fs.readFile(path, "utf8")).toBe("owner bytes");
  });

  it("refuses a writable shared staging directory without changing its owner files or mode", async () => {
    await fs.mkdir(staging());
    await fs.chmod(staging(), 0o777);
    await fs.writeFile(join(staging(), "owner-file.txt"), "owner bytes");
    const protectedTemp = join(staging(), "00000000-0000-0000-0000-000000000000.tmp");
    await fs.writeFile(protectedTemp, "owner bytes");
    const staleAt = new Date(Date.now() - 60 * 60_000);
    await fs.utimes(protectedTemp, staleAt, staleAt);
    await expect(tools().dispatch(binding, write("report.txt"), signal)).rejects.toEqual(new BotBrokerActionError("unavailable"));
    await sweepBotWorkspaceSaves(home);
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readFile(join(staging(), "owner-file.txt"), "utf8")).toBe("owner bytes");
    expect(await fs.readFile(protectedTemp, "utf8")).toBe("owner bytes");
    expect((await fs.stat(staging())).mode & 0o777).toBe(0o777);
  });
});
