import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalExitRecorder } from "../../packages/terminal-runtime/src/exit-recorder.js";
import { TerminalRuntime } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";

async function seedTab(store: TerminalWorkspaceStore, projectId?: string) {
  const workspace = await store.ensureWorkspace({ projectId });
  const tab = await store.createTab(workspace.id, { name: "command", cwd: "" });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
  const state = (await store.getRuntimeWorkspace(workspace.id))!;
  return { ref, session: state.zellijSessionName, name: state.tabs[tab.id]!.zellijTabName };
}

describe("final output of a held command pane", () => {
  it.each(["in-flight update", "queued update with an unresponsive final dump"] as const)(
    "persists the %s and releases the workspace queue when the last command exits",
    async (scenario) => {
      const homePath = await mkdtemp(join(tmpdir(), "matrix-final-checkpoint-"));
      const store = new TerminalWorkspaceStore({ homePath });
      const exitDirectory = join(homePath, "exits");
      const exits = new TerminalExitRecorder({ directory: exitDirectory });
      const ended = await seedTab(store);
      const healthy = await seedTab(store, "healthy");
      const binaryPath = join(homePath, "zellij");
      const dumpCalls = join(homePath, "dump-calls");
      const shouldStall = scenario === "queued update with an unresponsive final dump";
      await exits.prepare();
      await writeFile(binaryPath, [
        "#!/bin/sh",
        'if [ "$1" = "list-sessions" ]; then printf "%s\\n" "$TEST_ENDED_SESSION" "$TEST_HEALTHY_SESSION"; exit 0; fi',
        'if [ "$2" = "$TEST_ENDED_SESSION" ]; then name="$TEST_ENDED_TAB"; else name="$TEST_HEALTHY_TAB"; fi',
        'case "$4" in',
        "  list-tabs) printf '[{\"tab_id\":1,\"name\":\"%s\"}]' \"$name\" ;;",
        "  list-panes) printf '[{\"id\":1,\"tab_id\":1,\"is_plugin\":false,\"pane_title\":\"%s\"}]' \"$name\" ;;",
        "  dump-screen)",
        '    if [ ! -f "$TEST_DUMP_CALLS" ] || [ "$TEST_STALL" = 1 ]; then',
        '      printf "%s\\n" "$$" >> "$TEST_DUMP_CALLS"; exec /bin/sleep 10',
        "    fi",
        '    printf "%s\\n" "$$" >> "$TEST_DUMP_CALLS"',
        "    printf 'history\\n\\033[32mfinal output\\033[m\\n' ;;",
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"), { mode: 0o700 });

      const closing = Promise.withResolvers<void>();
      let emit!: (line: string) => void;
      const adapter = new ZellijCliRuntimeAdapter({
        homePath, binaryPath, timeoutMs: 5_000,
        env: {
          TEST_ENDED_SESSION: ended.session, TEST_ENDED_TAB: ended.name,
          TEST_HEALTHY_SESSION: healthy.session, TEST_HEALTHY_TAB: healthy.name,
          TEST_DUMP_CALLS: dumpCalls, TEST_STALL: shouldStall ? "1" : "0",
        },
        spawnSubscription: (args, onLine) => {
          if (args[1] === ended.session) emit = onLine;
          return { close: async () => { if (args[1] === ended.session) closing.resolve(); } };
        },
      });
      vi.spyOn(adapter, "openAttachment").mockResolvedValue({
        write: async () => undefined, resize: async () => undefined, close: async () => undefined,
      });
      const runtime = new TerminalRuntime({ store, zellij: adapter, exits });
      const emitUpdate = (row: string) => emit(JSON.stringify({
        event: "pane_update", pane_id: "terminal_1", viewport: [row], scrollback: ["history"],
      }));
      const readCalls = async () => (await readFile(dumpCalls, "utf8")).trim().split("\n").map(Number);
      try {
        await runtime.restoreAll();
        emitUpdate(shouldStall ? "old output" : "final output");
        await vi.waitFor(async () => expect(await readCalls()).toHaveLength(1));
        if (shouldStall) {
          emitUpdate("older queued output");
          emitUpdate("final output");
        }

        await writeFile(join(exitDirectory, ended.name), "7\n");
        const sweep = runtime.sweepRecordedExits();
        await closing.promise;
        const start = Date.now();
        const viewer = await runtime.attach(healthy.ref, { viewerId: "desktop", send: () => undefined });
        await viewer.detach();
        expect(Date.now() - start).toBeLessThan(2_500);
        await expect(sweep).resolves.toEqual({ exited: 1 });
        await runtime.flushCheckpoints();
        await expect(store.getTab(ended.ref)).resolves.toMatchObject({ status: "exited", exitCode: 7 });
        const snapshot = await runtime.getSnapshot(ended.ref);
        expect(snapshot).toMatchObject({ viewport: ["final output"], scrollback: ["history"] });
        expect(snapshot?.ansi).toBe(shouldStall ? "history\r\nfinal output" : "history\n\x1b[32mfinal output\x1b[m");
        const pids = await readCalls();
        expect(pids).toHaveLength(2);
        await vi.waitFor(() => {
          for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
        });
      } finally {
        try { await runtime.shutdown(); }
        finally { await rm(homePath, { recursive: true, force: true }); }
      }
    }, 15_000,
  );
});
