// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainExistingTerminalSessionQueue,
  drainExistingTerminalSessionQueueWithRetry,
  enqueueExistingTerminalSession,
  hasQueuedExistingTerminalSession,
} from "../../shell/src/lib/provider-terminal-session.js";

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
    const fetcher = vi.fn(async () => Response.json({
      sessions: [
        { name: "provider-login", status: "active" },
        { name: "old-login", status: "exited" },
      ],
    }));
    enqueueExistingTerminalSession("provider-login", "window-a");
    enqueueExistingTerminalSession("old-login", "window-a");

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher }))
      .resolves.toEqual(["provider-login"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      `${window.location.origin}/api/terminal/sessions`,
      expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }),
    );
    expect(fetcher.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });

  it("fails closed on malformed lists and keeps other terminal targets queued", async () => {
    const fetcher = vi.fn(async () => Response.json({ sessions: [{ name: "provider-login", status: 42 }] }));
    enqueueExistingTerminalSession("provider-login", "window-a");
    enqueueExistingTerminalSession("other-login", "window-b");

    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher })).resolves.toEqual([]);
    const validFetcher = vi.fn(async () => Response.json({ sessions: [{ name: "other-login", status: "active" }] }));
    await expect(drainExistingTerminalSessionQueue("window-b", { fetcher: validFetcher }))
      .resolves.toEqual(["other-login"]);
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

    const inactive = vi.fn(async () => Response.json({
      sessions: [{ name: "provider-login", status: "exited" }],
    }));
    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher: inactive }))
      .resolves.toEqual([]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue"))
      .toContain("provider-login");

    const active = vi.fn(async () => Response.json({
      sessions: [{ name: "provider-login", status: "active" }],
    }));
    await expect(drainExistingTerminalSessionQueue("window-a", { fetcher: active }))
      .resolves.toEqual(["provider-login"]);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("retries retained handoffs with a bounded backoff until the session becomes active", async () => {
    enqueueExistingTerminalSession("provider-login", "window-a");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ sessions: [{ name: "provider-login", status: "exited" }] }))
      .mockResolvedValueOnce(Response.json({ sessions: [{ name: "provider-login", status: "active" }] }));
    const wait = vi.fn(async () => {});

    await expect(drainExistingTerminalSessionQueueWithRetry("window-a", {
      fetcher,
      wait,
      maxAttempts: 3,
    })).resolves.toEqual(["provider-login"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledWith(250);
    expect(sessionStorage.getItem("matrix:provider-terminal-session-queue")).toBe("[]");
  });

  it("stops retrying after the bounded attempt count and preserves the handoff", async () => {
    enqueueExistingTerminalSession("provider-login", "window-a");
    const fetcher = vi.fn(async () => Response.json({
      sessions: [{ name: "provider-login", status: "exited" }],
    }));
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
});
