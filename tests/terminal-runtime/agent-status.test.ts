import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentStatusForHookEvent,
  createTerminalAgentStatusIndex,
  terminalPaneStatusPath,
  writeTerminalPaneStatus,
} from "../../packages/terminal-runtime/src/agent-status.js";
import { workspaceRuntimeId } from "../../packages/terminal-runtime/src/user-systemd-workspace.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const session = `matrix-w-${"a".repeat(32)}`;
const workspaceId = `tws_${"0".repeat(32)}`;
const tabId = `tt_${"1".repeat(32)}`;
const otherTabId = `tt_${"2".repeat(32)}`;

async function home() {
  const root = await mkdtemp(join(tmpdir(), "matrix-agent-status-"));
  roots.push(root);
  return root;
}

function storeWith(tabs: Array<{ id: string; zellijPaneId: string | null; status?: string; zellijPaneAssignedAt?: string }>) {
  return {
    listWorkspaces: async () => [{ id: workspaceId }],
    getRuntimeWorkspace: async (id: string) => id !== workspaceId ? undefined : {
      id: workspaceId,
      zellijSessionName: session,
      tabs: Object.fromEntries(tabs.map((tab) => [tab.id, { status: "running", ...tab }])),
    },
  };
}

describe("terminal agent status", () => {
  // Fault detected: a status reported in one pane is shown on another tab, or a
  // canonical workspace's tabs all share one status (today's per-session hooks).
  it("maps each pane's report to exactly its own tab", async () => {
    const homePath = await home();
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "7", status: "blocked", message: "Allow edit?", source: "reporter", now: () => new Date("2026-11-11T10:00:00Z") });
    const index = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith([{ id: tabId, zellijPaneId: "terminal_7" }, { id: otherTabId, zellijPaneId: "terminal_8" }]),
    });
    await expect(index.list()).resolves.toEqual([{
      ref: { workspaceId, tabId },
      status: "blocked",
      message: "Allow edit?",
      reportedAt: "2026-11-11T10:00:00.000Z",
      source: "reporter",
    }]);
  });

  // Fault detected (second review of #3297): on customer VPSes zellij runs a workspace
  // under its physical name `matrix-rt_<hash>`, so pane reports never reached the tab.
  it("maps reports written under a workspace's physical zellij session name", async () => {
    const homePath = await home();
    const physical = `matrix-${workspaceRuntimeId(session)}`;
    await writeTerminalPaneStatus({ homePath, sessionName: physical, paneId: "7", status: "working", source: "reporter" });
    const index = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith([{ id: tabId, zellijPaneId: "terminal_7" }]),
    });
    await expect(index.list()).resolves.toEqual([expect.objectContaining({ ref: { workspaceId, tabId }, status: "working" })]);
  });

  it("writes atomically with owner-only permissions and strips control characters", async () => {
    const homePath = await home();
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "3", status: "working", message: "\x1b]0;evil\x07build\nnow", source: "hook" });
    const path = terminalPaneStatusPath(homePath, session, "3");
    expect(((await lstat(path)).mode & 0o777)).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ status: "working", message: "]0;evilbuildnow" });
  });

  it("rejects identities that could escape the status folder", async () => {
    const homePath = await home();
    for (const [sessionName, paneId] of [["../x", "1"], [session, "../../1"], [session, "1;rm"], ["matrix-w-short", "1"]]) {
      await expect(writeTerminalPaneStatus({ homePath, sessionName: sessionName!, paneId: paneId!, status: "idle", source: "reporter" }))
        .rejects.toThrow();
    }
  });

  // Fault detected: a planted symlink or torn file crashes the index or redirects reads.
  it("ignores symlinked, oversized and invalid status files", async () => {
    const homePath = await home();
    const dir = join(homePath, "system", "terminal-status", session);
    await mkdir(dir, { recursive: true });
    const outside = join(homePath, "outside.json");
    await writeFile(outside, JSON.stringify({ version: 1, status: "done", reportedAt: "2026-11-11T10:00:00.000Z", source: "reporter" }));
    await symlink(outside, join(dir, "terminal_1.json"));
    await writeFile(join(dir, "terminal_2.json"), "{not json");
    await writeFile(join(dir, "terminal_3.json"), JSON.stringify({ version: 1, status: "dancing", reportedAt: "2026-11-11T10:00:00.000Z", source: "reporter" }));
    await writeFile(join(dir, "terminal_4.json"), "x".repeat(5_000));
    const index = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith(["1", "2", "3", "4"].map((pane, i) => ({ id: `tt_${String(i + 3).repeat(32)}`, zellijPaneId: `terminal_${pane}` }))),
    });
    await expect(index.list()).resolves.toEqual([]);
  });

  // Fault detected (#3297 review): a program in a reused pane number shows the old
  // program's blocked/done status, so sends are refused and waits end at once.
  it("ignores a report written before the tab got its current pane", async () => {
    const homePath = await home();
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "7", status: "blocked", source: "reporter", now: () => new Date("2026-11-11T10:00:00Z") });
    const stale = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith([{ id: tabId, zellijPaneId: "terminal_7", zellijPaneAssignedAt: "2026-11-11T10:05:00.000Z" }]),
    });
    await expect(stale.list()).resolves.toEqual([]);
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "7", status: "working", source: "reporter", now: () => new Date("2026-11-11T10:06:00Z") });
    await expect(stale.list()).resolves.toMatchObject([{ ref: { workspaceId, tabId }, status: "working" }]);
  });

  // matrix-status writes whole seconds: a program reporting in the same second its
  // pane was assigned must keep its status.
  it("keeps a whole-second report from the second the pane was assigned", async () => {
    const homePath = await home();
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "7", status: "working", source: "reporter", now: () => new Date("2026-11-11T10:05:00Z") });
    const index = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith([{ id: tabId, zellijPaneId: "terminal_7", zellijPaneAssignedAt: "2026-11-11T10:05:00.750Z" }]),
    });
    await expect(index.list()).resolves.toMatchObject([{ status: "working" }]);
  });

  // Fault detected (#3297 review): past 1,024 tabs, later tabs lost their status.
  it("keeps status for every live tab the runtime allows", async () => {
    const homePath = await home();
    const tabs = Array.from({ length: 1_100 }, (_, i) => ({ id: `tt_${i.toString(16).padStart(32, "0")}`, zellijPaneId: `terminal_${i}` }));
    for (let i = 0; i < tabs.length; i += 1) {
      await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: String(i), status: i === 1_099 ? "blocked" : "working", source: "reporter" });
    }
    const index = createTerminalAgentStatusIndex({ homePath, store: storeWith(tabs) });
    const entries = await index.list();
    expect(entries).toHaveLength(1_100);
    expect(entries.find((entry) => entry.ref.tabId === tabs[1_099]!.id)?.status).toBe("blocked");
  });

  it("drops status for tabs that have ended", async () => {
    const homePath = await home();
    await writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "7", status: "working", source: "reporter" });
    const index = createTerminalAgentStatusIndex({
      homePath,
      store: storeWith([{ id: tabId, zellijPaneId: "terminal_7", status: "exited" }]),
    });
    await expect(index.list()).resolves.toEqual([]);
  });

  it("maps agent hook events to Herdr's status words", () => {
    expect(agentStatusForHookEvent("session-started")).toBe("idle");
    expect(agentStatusForHookEvent("turn-started")).toBe("working");
    expect(agentStatusForHookEvent("attention-requested")).toBe("blocked");
    expect(agentStatusForHookEvent("turn-completed")).toBe("done");
    expect(agentStatusForHookEvent("session-ended")).toBe("idle");
    expect(agentStatusForHookEvent("subtitle-updated")).toBeUndefined();
    // A tool finishing after a permission prompt means the agent is working again.
    expect(agentStatusForHookEvent("action-updated")).toBe("working");
  });

  // Fault detected: a failed status write leaves temporary files piling up in the owner's home.
  it("removes its temporary file when the write itself fails", async () => {
    const homePath = await home();
    const dir = join(homePath, "system", "terminal-status", session);
    await mkdir(dir, { recursive: true });
    // A directory where the target file goes makes the final rename fail.
    await mkdir(join(dir, "terminal_9.json"));
    await expect(writeTerminalPaneStatus({ homePath, sessionName: session, paneId: "9", status: "idle", source: "reporter" })).rejects.toThrow();
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // Fault detected: a helper started from a terminal records the wrong parent, so
  // its report lands in another agent's input.
  it("resolves a pane to exactly its live tab", async () => {
    const index = createTerminalAgentStatusIndex({
      homePath: await home(),
      store: storeWith([
        { id: tabId, zellijPaneId: "terminal_7" },
        { id: otherTabId, zellijPaneId: "terminal_8", status: "exited" },
      ]),
    });
    await expect(index.resolvePane(session, "7")).resolves.toEqual({ workspaceId, tabId });
    await expect(index.resolvePane(session, "8")).resolves.toBeUndefined();
    await expect(index.resolvePane(session, "70")).resolves.toBeUndefined();
    await expect(index.resolvePane(`matrix-w-${"b".repeat(32)}`, "7")).resolves.toBeUndefined();
    await expect(index.resolvePane(session, "../7")).resolves.toBeUndefined();
  });
});
