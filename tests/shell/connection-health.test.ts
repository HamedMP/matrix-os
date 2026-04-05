import { describe, it, expect, vi, beforeEach } from "vitest";

describe("ConnectionHealth store", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("defaults to disconnected state", async () => {
    const { useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    expect(useConnectionHealth.getState().state).toBe("disconnected");
  });

  it("updates state via setState", async () => {
    const { useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    useConnectionHealth.setState({ state: "connected" });
    expect(useConnectionHealth.getState().state).toBe("connected");
  });

  it("supports reconnecting state", async () => {
    const { useConnectionHealth } = await import(
      "../../shell/src/hooks/useConnectionHealth.js"
    );
    useConnectionHealth.setState({ state: "reconnecting" });
    expect(useConnectionHealth.getState().state).toBe("reconnecting");
  });
});
