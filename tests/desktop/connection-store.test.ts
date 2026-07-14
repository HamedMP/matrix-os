// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  unwireConnectionEvents,
  useConnection,
  wireConnectionEvents,
} from "@desktop/renderer/src/stores/connection";
import { useBoard } from "@desktop/renderer/src/stores/board";

type Listener = (payload: unknown) => void;

beforeEach(() => {
  useConnection.setState({
    status: "loading",
    handle: null,
    platformHost: "",
    runtimeSlot: "primary",
    authGeneration: 0,
    api: null,
  });
});

afterEach(() => {
  unwireConnectionEvents();
  vi.restoreAllMocks();
});

describe("connection event wiring", () => {
  it("keeps the previous desktop state intact until the trusted runtime switch succeeds", async () => {
    useBoard.setState({ projects: [{ slug: "old", name: "Old" }], activeProjectSlug: "old" });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:select") {
        expect(useBoard.getState()).toMatchObject({
          projects: [{ slug: "old", name: "Old" }],
          activeProjectSlug: "old",
        });
      }
      if (channel === "auth:status") {
        return {
          signedIn: true,
          handle: "neo-preview",
          platformHost: "https://app.matrix-os.com",
          runtimeSlot: "preview",
          authGeneration: 2,
        };
      }
      return {};
    });
    window.operator = { invoke, on: vi.fn() };

    await useConnection.getState().selectRuntime("preview");

    expect(invoke).toHaveBeenCalledWith("runtime:select", { slot: "preview" });
    expect(useBoard.getState()).toMatchObject({ projects: [], activeProjectSlug: null });
    expect(useConnection.getState().runtimeSlot).toBe("preview");
    // The post-switch refresh publishes the replacement session's snapshot.
    expect(useConnection.getState().authGeneration).toBe(2);
  });

  it("suppresses runtime event refreshes until the switch has reconciled", async () => {
    const listeners = new Map<string, Listener>();
    let resolveSelect!: (value: unknown) => void;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:select") {
        return new Promise((resolve) => {
          resolveSelect = resolve;
        });
      }
      if (channel === "auth:status") {
        return {
          signedIn: true,
          handle: "neo-review",
          platformHost: "https://app.matrix-os.com",
          runtimeSlot: "review",
          authGeneration: 2,
        };
      }
      return {};
    });
    window.operator = {
      invoke,
      on: vi.fn((channel: string, callback: Listener) => {
        listeners.set(channel, callback);
        return () => {
          listeners.delete(channel);
        };
      }),
    };
    wireConnectionEvents();
    useBoard.setState({ projects: [{ slug: "old", name: "Old" }], activeProjectSlug: "old" });

    const pending = useConnection.getState().selectRuntime("review");
    // The trusted core emits runtime:changed before the invoke resolves; the
    // wired listener must not publish the new slot before reconciliation.
    listeners.get("runtime:changed")?.({ slot: "review" });
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalledWith("auth:status", {});
    expect(useConnection.getState().runtimeSlot).toBe("primary");
    expect(useBoard.getState()).toMatchObject({ projects: [{ slug: "old", name: "Old" }] });

    resolveSelect({});
    await pending;

    expect(useBoard.getState()).toMatchObject({ projects: [], activeProjectSlug: null });
    expect(useConnection.getState().runtimeSlot).toBe("review");
    expect(useConnection.getState().authGeneration).toBe(2);
  });

  it("preserves desktop state and the selected slot when the runtime switch fails", async () => {
    useBoard.setState({ projects: [{ slug: "old", name: "Old" }], activeProjectSlug: "old" });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:select") throw new Error("switch failed");
      if (channel === "auth:status") {
        return {
          signedIn: true,
          handle: "neo",
          platformHost: "https://app.matrix-os.com",
          runtimeSlot: "primary",
          authGeneration: 1,
        };
      }
      return {};
    });
    window.operator = { invoke, on: vi.fn() };

    await expect(useConnection.getState().selectRuntime("preview")).rejects.toThrow();

    expect(useBoard.getState()).toMatchObject({
      projects: [{ slug: "old", name: "Old" }],
      activeProjectSlug: "old",
    });
    expect(useConnection.getState().runtimeSlot).toBe("primary");
  });

  it("exposes the trusted-core auth generation on refresh", async () => {
    window.operator = {
      invoke: vi.fn(async () => ({
        signedIn: true,
        handle: "neo",
        platformHost: "https://app.matrix-os.com",
        runtimeSlot: "primary",
        authGeneration: 7,
      })),
      on: vi.fn(),
    };

    await useConnection.getState().refresh();

    expect(useConnection.getState().authGeneration).toBe(7);
  });

  it("recovers from an initial auth status failure instead of staying loading", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    window.operator = {
      invoke: vi.fn().mockRejectedValue(new Error("ipc unavailable")),
      on: vi.fn(),
    };

    await useConnection.getState().refresh();

    expect(useConnection.getState().status).toBe("signed-out");
    expect(useConnection.getState().api).toBeNull();
    expect(warn).toHaveBeenCalledWith("[connection] failed to refresh auth status:", "ipc unavailable");
  });

  it("unwires auth and runtime listeners so tests can reinitialize the bridge", async () => {
    const listeners = new Map<string, Listener>();
    const invoke = vi.fn().mockResolvedValue({
      signedIn: false,
      platformHost: "https://platform.test",
      runtimeSlot: "primary",
    });
    window.operator = {
      invoke,
      on: vi.fn((channel: string, callback: Listener) => {
        listeners.set(channel, callback);
        return () => {
          listeners.delete(channel);
        };
      }),
    };

    wireConnectionEvents();
    listeners.get("auth:changed")?.({});
    await Promise.resolve();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(listeners.has("auth:changed")).toBe(true);
    expect(listeners.has("runtime:changed")).toBe(true);

    unwireConnectionEvents();

    expect(listeners.has("auth:changed")).toBe(false);
    expect(listeners.has("runtime:changed")).toBe(false);

    wireConnectionEvents();
    listeners.get("runtime:changed")?.({});
    await Promise.resolve();

    expect(window.operator.on).toHaveBeenCalledTimes(4);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
