// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  unwireConnectionEvents,
  useConnection,
  wireConnectionEvents,
} from "@desktop/renderer/src/stores/connection";

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
