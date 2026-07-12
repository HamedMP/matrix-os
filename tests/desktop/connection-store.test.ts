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
    api: null,
  });
});

afterEach(() => {
  unwireConnectionEvents();
  vi.restoreAllMocks();
});

describe("connection event wiring", () => {
  it("invalidates the previous runtime before the trusted runtime switch", async () => {
    useBoard.setState({ projects: [{ slug: "old", name: "Old" }], activeProjectSlug: "old" });
    const invoke = vi.fn(async (channel: string) => {
      if (channel === "runtime:select") {
        expect(useBoard.getState()).toMatchObject({ projects: [], activeProjectSlug: null });
      }
      return {};
    });
    window.operator = { invoke, on: vi.fn() };

    await useConnection.getState().selectRuntime("preview");

    expect(invoke).toHaveBeenCalledWith("runtime:select", { slot: "preview" });
    expect(useConnection.getState().runtimeSlot).toBe("preview");
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
