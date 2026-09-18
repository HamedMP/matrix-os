import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prepareNativeScrollPlugin, queryNativeScroll, NATIVE_SCROLL_PLUGIN } from "../../packages/terminal-runtime/src/native-scroll-bridge.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import { terminalAttachmentAllowsFrame } from "../../packages/gateway/src/session-runtime-bridge.js";

const logical = `matrix-w-${"a".repeat(32)}`;
const physical = `matrix-rt_${"a".repeat(32)}`;
const cacheFor = (home: string) => process.platform === "darwin" ? join(home, "Library/Caches/org.Zellij-Contributors.Zellij") : join(home, ".cache/zellij");
describe("native scroll bridge", () => {
  it("uses the resolved production session and preserves existing permission grants", async () => {
    const homePath = await mkdtemp(join(tmpdir(), "scroll-bridge-"));
    try {
      const cache = cacheFor(homePath); await mkdir(cache, { recursive: true });
      await writeFile(join(cache, "permissions.kdl"), '"owner-plugin" { ReadApplicationState; }\n');
      const run = vi.fn(async () => '{"above":10,"below":30,"rows":36}');
      const adapter = new ZellijCliRuntimeAdapter({ homePath, env: {}, run,
        workspaceLifecycle: { resolveWorkspaceTarget: async () => ({ sessionName: physical, binaryPath: "/generation/zellij" }),
          ensureWorkspaceSession: async () => ({ sessionName: physical, binaryPath: "/generation/zellij" }), deleteWorkspaceSession: async () => {} },
      });
      expect(await adapter.scrollState(logical, "terminal_7", 10)).toEqual({ above: 10, below: 30, rows: 36 });
      expect(run.mock.calls[0]).toEqual([["--session", physical, "pipe", "--plugin", `file:${NATIVE_SCROLL_PLUGIN}`,
        "--name", "matrix-scroll-v1", '{"pane":7,"line":10}'], "/generation/zellij"]);
      const permissions = await readFile(join(cache, "permissions.kdl"), "utf8");
      expect(permissions).toContain('"owner-plugin" { ReadApplicationState; }');
      await prepareNativeScrollPlugin(homePath, {});
      expect(await readFile(join(cache, "permissions.kdl"), "utf8")).toBe(permissions);
    } finally { await rm(homePath, { recursive: true, force: true }); }
  });
  it("rejects symlinked cache parents without creating anything in their target", async () => {
    const home = await mkdtemp(join(tmpdir(), "scroll-home-"));
    const outside = await mkdtemp(join(tmpdir(), "scroll-outside-"));
    try {
      await symlink(outside, join(home, process.platform === "darwin" ? "Library" : ".cache"));
      await expect(prepareNativeScrollPlugin(home, {})).rejects.toThrow("cache unavailable");
      expect(await readdir(outside)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
  });
  it("rejects malformed replies and identities with bounded command execution", async () => {
    const run = vi.fn(async () => "x".repeat(513));
    await expect(queryNativeScroll({ sessionName: physical, paneId: "terminal_1", run })).rejects.toThrow("exceeds limit");
    expect(run.mock.calls[0]?.[1]).toBe(3000);
    await expect(queryNativeScroll({ sessionName: "--other", paneId: "terminal_1", run })).rejects.toThrow("identity");
    expect(run).toHaveBeenCalledOnce();
  });
  it("permits observer queries but rejects seeks", () => {
    const terminalRef = { workspaceId: `tws_${"a".repeat(32)}`, tabId: `tt_${"b".repeat(32)}` };
    expect(terminalAttachmentAllowsFrame("observe", { type: "scroll-query", terminalRef })).toBe(true);
    expect(terminalAttachmentAllowsFrame("observe", { type: "scroll-to", terminalRef, line: 5 })).toBe(false);
  });
});

it("ships the WASI artifact built from the recorded pinned source", async () => {
  const { createHash } = await import("node:crypto");
  const base = new URL("../../packages/terminal-runtime/native-scroll/", import.meta.url);
  const manifest: Record<string, string> = JSON.parse(await readFile(new URL("manifest.json", base), "utf8"));
  for (const [path, hash] of Object.entries(manifest)) {
    expect(createHash("sha256").update(await readFile(new URL(path, base))).digest("hex"), path).toBe(hash);
  }
});
