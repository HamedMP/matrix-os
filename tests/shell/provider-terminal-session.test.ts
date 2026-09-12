// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainExistingTerminalSessionQueue,
  drainExistingTerminalSessionQueueWithRetry,
  enqueueExistingTerminalRef,
  enqueueExistingTerminalSession,
  hasQueuedExistingTerminalSession,
} from "../../shell/src/lib/provider-terminal-session.js";

const WORKSPACE_ID = `tws_${"a".repeat(32)}`;
const PROVIDER_TAB_ID = `tt_${"b".repeat(32)}`;
const OLD_TAB_ID = `tt_${"c".repeat(32)}`;
const OTHER_TAB_ID = `tt_${"d".repeat(32)}`;
const providerRef = `${WORKSPACE_ID}:${PROVIDER_TAB_ID}`;
const otherRef = `${WORKSPACE_ID}:${OTHER_TAB_ID}`;

function workspaceResponse(tabs: unknown[]) {
  return {
    workspaces: [{
      id: WORKSPACE_ID,
      scope: "main",
      status: "running",
      tabs,
    }],
  };
}

function tab(id: string, name: string, status: unknown) {
  return { id, name, status };
}

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

describe("provider terminal session handoff", () => {
  it("queues only opaque canonical session ids and targets the active terminal", () => {
    expect(enqueueExistingTerminalSession("term_observe_abc123", "window-a")).toBe(false);
    expect(enqueueExistingTerminalSession("provider-login", "window-a")).toBe(true);
  });

  it("attaches only a listed non-exited session and never creates or executes anything", async () => {
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "running"),
      tab(OLD_TAB_ID, "old-login", "exited"),
    ])));
    enqueueExistingTerminalSession("provider-login", "window-a");
    enqueueExistingTerminalSession("old-login", "window-a");

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher }))
      .resolves.toEqual([providerRef]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${window.location.origin}/api/terminal/workspaces`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("hands off full-length provider login IDs after validation against the live session list", async () => {
    const sessionId = `provider-auth-${"a".repeat(50)}`;
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, sessionId, "running"),
    ])));
    expect(enqueueExistingTerminalSession(sessionId, "window-login")).toBe(true);
    expect(enqueueExistingTerminalSession(`${sessionId}a`, "window-login")).toBe(false);
    expect(enqueueExistingTerminalSession("550e8400-e29b-41d4-a716-446655440000", "window-login"))
      .toBe(false);
    await expect(drainExistingTerminalSessionQueue("window-login", { fetcher }))
      .resolves.toEqual([providerRef]);
    expect(hasQueuedExistingTerminalSession("window-login")).toBe(false);
  });

  it("fails closed on malformed lists and keeps other terminal targets queued", async () => {
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", 42),
    ])));
    enqueueExistingTerminalSession("provider-login", "window-a");
    enqueueExistingTerminalSession("other-login", "window-b");

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher })).resolves.toEqual([]);
    const validFetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(OTHER_TAB_ID, "other-login", "running"),
    ])));
    await expect(drainExistingTerminalSessionQueue("window-b", { fetcher: validFetcher }))
      .resolves.toEqual([otherRef]);
  });

  it("retains matched handoffs until the server confirms the session is active", async () => {
    enqueueExistingTerminalSession("provider-login", "window-a");
    const unavailable = vi.fn(async () => {
      throw new TypeError("offline");
    });

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher: unavailable }))
      .resolves.toEqual([]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue"))
      .toContain("provider-login");

    const inactive = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "exited"),
    ])));
    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher: inactive }))
      .resolves.toEqual([]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue"))
      .toContain("provider-login");

    const active = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "running"),
    ])));
    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher: active }))
      .resolves.toEqual([providerRef]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("retries retained handoffs with a bounded backoff until the session becomes active", async () => {
    enqueueExistingTerminalSession("provider-login", "window-a");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json(workspaceResponse([tab(PROVIDER_TAB_ID, "provider-login", "exited")])))
      .mockResolvedValueOnce(Response.json(workspaceResponse([tab(PROVIDER_TAB_ID, "provider-login", "running")])))
    const wait = vi.fn(async () => {});

    await expect(drainExistingTerminalSessionQueueWithRetry("window-a", {
      fetcher,
      wait,
      maxAttempts: 3,
    })).resolves.toEqual([providerRef]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("stops retrying after the bounded attempt count and preserves the handoff", async () => {
    enqueueExistingTerminalSession("provider-login", "window-a");
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "exited"),
    ])));
    const wait = vi.fn(async () => {});

    await expect(drainExistingTerminalSessionQueueWithRetry("window-a", {
      fetcher,
      wait,
      maxAttempts: 4,
    })).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue"))
      .toContain("provider-login");
    expect(hasQueuedExistingTerminalSession("window-a")).toBe(true);
  });

  it("expires retained handoffs so background retries remain bounded", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    enqueueExistingTerminalSession("provider-login", "window-a");

    expect(hasQueuedExistingTerminalSession("window-a")).toBe(true);
    now.mockReturnValue(11 * 60_000);
    expect(hasQueuedExistingTerminalSession("window-a")).toBe(false);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("keeps a canonical running-command handoff past the legacy discovery timeout", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    enqueueExistingTerminalRef(providerRef, "window-a");

    now.mockReturnValue(11 * 60_000);
    expect(hasQueuedExistingTerminalSession("window-a")).toBe(true);
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "running"),
    ])));
    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher }))
      .resolves.toEqual([providerRef]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("removes a canonical handoff after an authoritative list proves it inactive", async () => {
    enqueueExistingTerminalRef(providerRef, "window-a");
    const fetcher = vi.fn(async () => Response.json(workspaceResponse([
      tab(PROVIDER_TAB_ID, "provider-login", "exited"),
    ])));

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher }))
      .resolves.toEqual([]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("migrates the preceding queue format without making its lifetime unbounded", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    sessionStorage.setItem("matrix:provider-terminal-session-queue", JSON.stringify([
      { sessionId: "provider-login", targetId: "window-a" },
    ]));

    expect(hasQueuedExistingTerminalSession("window-a")).toBe(true);
    expect(JSON.parse(sessionStorage.getItem("matrix:provider-terminal-session-queue") ?? "[]"))
      .toEqual([{ sessionId: "provider-login", targetId: "window-a", expiresAt: 601_000 }]);

    now.mockReturnValue(601_001);
    expect(hasQueuedExistingTerminalSession("window-a")).toBe(false);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });
});
