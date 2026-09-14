import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TerminalLayoutRevisionConflictError,
  TerminalWindowLayoutStore,
} from "../../packages/gateway/src/shell/terminal-window-layout-store.js";

const FIRST_LAYOUT_ID = "term-layout_0123456789abcdef0123456789abcdef";
const SECOND_LAYOUT_ID = "term-layout_fedcba9876543210fedcba9876543210";

function layoutWithSession(sessionId: string) {
  return {
    tabs: [{
      id: `tab-${sessionId}`,
      label: sessionId,
      paneTree: {
        type: "pane" as const,
        id: `pane-${sessionId}`,
        cwd: "projects",
        sessionId,
      },
    }],
    activeTabId: `tab-${sessionId}`,
    sidebarOpen: true,
  };
}

describe("terminal window layout store", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-terminal-layouts-"));
  });

  afterEach(async () => {
    await rm(homePath, { recursive: true, force: true });
  });

  it("keeps independent revisions for distinct Terminal windows", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });

    await expect(store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("alpha"))).resolves.toMatchObject({ revision: 1 });
    await expect(store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("beta"))).resolves.toMatchObject({ revision: 1 });
    await expect(store.put(FIRST_LAYOUT_ID, 1, layoutWithSession("gamma"))).resolves.toMatchObject({ revision: 2 });

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 2,
      layout: { tabs: [{ paneTree: { sessionId: "gamma" } }] },
    });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "beta" } }] },
    });
  });

  it("rejects stale writes without replacing the current layout", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("alpha"));

    await expect(store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("stale"))).rejects.toBeInstanceOf(
      TerminalLayoutRevisionConflictError,
    );
    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "alpha" } }] },
    });
  });

  it("tombstones a deleted session across every layout and rejects stale resurrection", async () => {
    const store = new TerminalWindowLayoutStore({
      homePath,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    await store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));

    await store.deleteSessionReferences("deleted-shell");

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });

    const staleWrite = await store.put(FIRST_LAYOUT_ID, 2, layoutWithSession("deleted-shell"));
    expect(staleWrite.layout.tabs).toEqual([]);
    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({ layout: { tabs: [] } });
  });

  it("allows explicit recovery to clear a deletion tombstone", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.deleteSessionReferences("recover-me");
    await store.clearSessionTombstone("recover-me");

    const saved = await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("recover-me"));

    expect(saved.layout.tabs).toHaveLength(1);
    expect(saved.layout.tabs[0]?.paneTree).toMatchObject({ sessionId: "recover-me" });
  });

  it("lists active session tombstones for visibility reconciliation", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.deleteSessionReferences("deleted-shell");

    await expect(store.listSessionTombstones()).resolves.toEqual(["deleted-shell"]);
    await expect(store.isSessionTombstoned("deleted-shell")).resolves.toBe(true);
    await store.clearSessionTombstone("deleted-shell");
    await expect(store.isSessionTombstoned("deleted-shell")).resolves.toBe(false);
  });

  it("treats pre-upgrade tombstones without lifecycle state as completed", async () => {
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(
      join(homePath, "system", "terminal-window-layouts.json"),
      JSON.stringify({
        version: 1,
        layouts: {},
        tombstones: [{
          sessionName: "legacy-deleted",
          deletedAt: "2026-08-30T00:00:00.000Z",
        }],
      }),
      { flag: "wx" },
    );
    const store = new TerminalWindowLayoutStore({
      homePath,
      now: () => new Date("2026-08-30T00:00:01.000Z"),
    });

    await expect(store.listSessionTombstones()).resolves.toEqual(["legacy-deleted"]);
    await expect(store.listPendingSessionDeletions()).resolves.toEqual([]);
  });

  it("keeps pending deletion intents until completion and only then applies tombstone expiry", async () => {
    let now = new Date("2026-08-30T00:00:00.000Z");
    const store = new TerminalWindowLayoutStore({ homePath, now: () => now });

    await store.beginSessionDeletion("pending-shell");
    now = new Date("2026-10-15T00:00:00.000Z");

    await expect(store.listPendingSessionDeletions()).resolves.toEqual(["pending-shell"]);
    await expect(store.listSessionTombstones()).resolves.toEqual(["pending-shell"]);

    await store.completeSessionDeletion("pending-shell");
    now = new Date("2026-12-01T00:00:00.000Z");

    await expect(store.listPendingSessionDeletions()).resolves.toEqual([]);
    await expect(store.listSessionTombstones()).resolves.toEqual([]);
  });

  it("fails closed before evicting an unfinished deletion intent at capacity", async () => {
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(
      join(homePath, "system", "terminal-window-layouts.json"),
      JSON.stringify({
        version: 1,
        layouts: {},
        tombstones: Array.from({ length: 256 }, (_, index) => ({
          sessionName: `pending-${index}`,
          deletedAt: "2026-08-30T00:00:00.000Z",
          state: "pending",
        })),
      }),
      { flag: "wx" },
    );
    const store = new TerminalWindowLayoutStore({
      homePath,
      now: () => new Date("2026-08-30T00:00:01.000Z"),
    });

    await expect(store.beginSessionDeletion("overflow")).rejects.toThrow(
      "Terminal deletion intent capacity exceeded",
    );
    await expect(store.listPendingSessionDeletions()).resolves.toHaveLength(256);
  });

  it("coordinates shell deletion with reconciliation across every window layout", async () => {
    const store = new TerminalWindowLayoutStore({ homePath });
    await store.put(FIRST_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    await store.put(SECOND_LAYOUT_ID, 0, layoutWithSession("deleted-shell"));
    const registry = {
      list: vi.fn(async () => []),
      create: vi.fn(),
      delete: vi.fn(async () => undefined),
    };
    await store.withSessionLifecycleLock("deleted-shell", async () => {
      await store.beginSessionDeletion("deleted-shell");
      await registry.delete("deleted-shell", { force: true });
      await store.completeSessionDeletion("deleted-shell");
    });

    expect(registry.delete).toHaveBeenCalledWith("deleted-shell", { force: true });
    for (const layoutId of [FIRST_LAYOUT_ID, SECOND_LAYOUT_ID]) {
      await expect(store.get(layoutId)).resolves.toMatchObject({
        revision: 2,
        layout: { tabs: [] },
      });
    }
  });

  it("migrates the legacy global layout into exactly one stable window id", async () => {
    await mkdir(join(homePath, "system"), { recursive: true });
    await writeFile(
      join(homePath, "system", "terminal-layout.json"),
      JSON.stringify(layoutWithSession("legacy-shell")),
    );
    const store = new TerminalWindowLayoutStore({ homePath });

    await expect(store.get(FIRST_LAYOUT_ID)).resolves.toMatchObject({
      revision: 1,
      layout: { tabs: [{ paneTree: { sessionId: "legacy-shell" } }] },
    });
    await expect(store.get(SECOND_LAYOUT_ID)).resolves.toMatchObject({
      revision: 0,
      layout: { tabs: [] },
    });
  });
});
