// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  drainExistingTerminalSessionQueue,
  enqueueExistingTerminalSession,
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
});
