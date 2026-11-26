import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TerminalRuntime } from "../../packages/terminal-runtime/src/runtime.js";
import { TerminalWorkspaceStore } from "../../packages/terminal-runtime/src/workspace-store.js";
import { ZellijCliRuntimeAdapter } from "../../packages/terminal-runtime/src/zellij-adapter.js";
import { createZellijObserver } from "../../packages/terminal-runtime/src/zellij-observer.js";

async function seedTab(store: TerminalWorkspaceStore, projectId?: string) {
  const workspace = await store.ensureWorkspace({ projectId });
  const tab = await store.createTab(workspace.id, { name: "shell", cwd: "" });
  const ref = { workspaceId: workspace.id, tabId: tab.id };
  await store.activateTab(ref, { tabId: 1, paneId: "terminal_1" });
  const state = (await store.getRuntimeWorkspace(workspace.id))!;
  return { ref, session: state.zellijSessionName, name: state.tabs[tab.id]!.zellijTabName };
}

describe("workspace observer replacement", () => {
  it.each(["reopen", "missing-observer recovery"] as const)(
    "frees the shared queue during %s when the old observer's screen dump is stalled",
    async (trigger) => {
      const homePath = await mkdtemp(join(tmpdir(), "matrix-observer-restore-"));
      const store = new TerminalWorkspaceStore({ homePath });
      const bad = await seedTab(store);
      const good = await seedTab(store, "healthy");
      const binaryPath = join(homePath, "zellij");
      const dumpCalls = join(homePath, "dump-calls");
      await writeFile(binaryPath, [
        "#!/bin/sh",
        'if [ "$1" = "list-sessions" ]; then printf "%s\\n" "$TEST_BAD_SESSION" "$TEST_GOOD_SESSION"; exit 0; fi',
        'if [ "$2" = "$TEST_BAD_SESSION" ]; then name="$TEST_BAD_TAB"; else name="$TEST_GOOD_TAB"; fi',
        'case "$4" in',
        "  list-tabs) printf '[{\"tab_id\":1,\"name\":\"%s\"}]' \"$name\" ;;",
        "  list-panes) printf '[{\"id\":1,\"tab_id\":1,\"is_plugin\":false,\"pane_title\":\"%s\"}]' \"$name\" ;;",
        '  dump-screen) printf "%s\\n" "$$" >> "$TEST_DUMP_CALLS"; exec /bin/sleep 5 ;;',
        "  *) exit 1 ;;",
        "esac",
        "",
      ].join("\n"), { mode: 0o700 });

      const subscriptions = new Map<string, { emit: (line: string) => void; exit: (code: number) => void }>();
      const closing = Promise.withResolvers<void>();
      const adapter = new ZellijCliRuntimeAdapter({
        homePath, binaryPath, timeoutMs: 2_500,
        env: {
          TEST_BAD_SESSION: bad.session, TEST_BAD_TAB: bad.name,
          TEST_GOOD_SESSION: good.session, TEST_GOOD_TAB: good.name, TEST_DUMP_CALLS: dumpCalls,
        },
        spawnSubscription: (args, emit, exit) => {
          const session = args[1]!;
          const first = !subscriptions.has(session);
          subscriptions.set(session, { emit, exit });
          return { close: async () => { if (first && session === bad.session) closing.resolve(); } };
        },
      });
      vi.spyOn(adapter, "openAttachment").mockResolvedValue({
        write: async () => undefined, resize: async () => undefined, close: async () => undefined,
      });
      const runtime = new TerminalRuntime({
        store, zellij: adapter, restoreRetryBudgetMs: 1_000, sweepIntervalMs: 25,
      });
      try {
        await runtime.restoreAll();
        const observer = subscriptions.get(bad.session)!;
        const update = JSON.stringify({ event: "pane_update", pane_id: "terminal_1", viewport: ["$"] });
        observer.emit(update);
        observer.emit(update);
        const readCalls = async () => (await readFile(dumpCalls, "utf8")).trim().split("\n").map(Number);
        await vi.waitFor(async () => expect(await readCalls()).toHaveLength(1));
        const [pid] = await readCalls();

        const reopen = trigger === "reopen" ? runtime.ensureWorkspace() : undefined;
        if (!reopen) observer.exit(0);
        await closing.promise;
        const startedAt = Date.now();
        const viewer = await runtime.attach(good.ref, { viewerId: "desktop", send: () => undefined });
        await viewer.detach();
        expect(Date.now() - startedAt).toBeLessThan(2_000);
        expect(await readCalls()).toEqual([pid]);
        await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(/ESRCH/));
        await reopen;
      } finally {
        try { await runtime.shutdown(); }
        finally { await rm(homePath, { recursive: true, force: true }); }
      }
    }, 15_000,
  );

  it.each([true, false])("keeps accepted pane-close events when discarding snapshots is %s", async (discardPendingSnapshots) => {
    const received = vi.fn();
    const started = Promise.withResolvers<AbortSignal>();
    const snapshot = Promise.withResolvers<string>();
    let emit!: (line: string) => void;
    const dumpPane = vi.fn((_paneId: string, signal: AbortSignal) => {
      started.resolve(signal);
      signal.addEventListener("abort", () => snapshot.reject(signal.reason), { once: true });
      return snapshot.promise;
    });
    const observer = createZellijObserver({
      onEvent: received,
      dumpPane,
      spawn: (onLine) => {
        emit = onLine;
        return { close: async () => undefined };
      },
    });
    const update = JSON.stringify({ event: "pane_update", pane_id: "terminal_1", viewport: ["$"] });
    emit(update);
    emit(update);
    emit(JSON.stringify({ event: "pane_closed", pane_id: "terminal_1" }));
    const signal = await started.promise;
    const closed = discardPendingSnapshots ? observer.close({ discardPendingSnapshots: true }) : observer.close();
    expect(signal.aborted).toBe(discardPendingSnapshots);
    if (!discardPendingSnapshots) snapshot.resolve("$");
    await closed;
    expect(dumpPane).toHaveBeenCalledTimes(discardPendingSnapshots ? 1 : 2);
    expect(received).toHaveBeenCalledTimes(discardPendingSnapshots ? 1 : 3);
    expect(received).toHaveBeenLastCalledWith({ type: "pane-closed", paneId: "terminal_1" });
  });
});
