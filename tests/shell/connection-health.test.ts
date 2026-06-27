import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("ConnectionHealth store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to initializing state", async () => {
    const { useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    expect(useConnectionHealth.getState().state).toBe("initializing");
    expect(useConnectionHealth.getState().hasConnected).toBe(false);
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(false);
  });

  it("tracks whether a connection has been established", async () => {
    const { setConnectionHealthState, useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    setConnectionHealthState("connected");
    expect(useConnectionHealth.getState().state).toBe("connected");
    expect(useConnectionHealth.getState().hasConnected).toBe(true);

    setConnectionHealthState("reconnecting");
    expect(useConnectionHealth.getState().state).toBe("reconnecting");
    expect(useConnectionHealth.getState().hasConnected).toBe(true);
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(false);
  });

  it("marks reconnect quiet window elapsed only after the delay", async () => {
    vi.useFakeTimers();
    const { setConnectionHealthState, useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );

    setConnectionHealthState("connected");
    setConnectionHealthState("reconnecting");
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(false);

    vi.advanceTimersByTime(4_999);
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(false);

    vi.advanceTimersByTime(1);
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(true);

    setConnectionHealthState("connected");
    expect(useConnectionHealth.getState().reconnectQuietElapsed).toBe(false);
  });

  it("supports reconnecting state", async () => {
    const { setConnectionHealthState, useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    setConnectionHealthState("reconnecting");
    expect(useConnectionHealth.getState().state).toBe("reconnecting");
  });

  it("supports disconnected state", async () => {
    const { setConnectionHealthState, useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    setConnectionHealthState("disconnected");
    expect(useConnectionHealth.getState().state).toBe("disconnected");
  });
});
