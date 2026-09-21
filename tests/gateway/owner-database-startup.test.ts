import { describe, expect, it, vi } from "vitest";
import { bootOwnerDatabaseWithFallback } from "../../packages/gateway/src/startup/owner-database.js";

describe("owner database startup", () => {
  it("drains every partial service after Chat handoff fails before collaboration construction", async () => {
    const order: string[] = [];
    const warn = vi.fn();
    const result = await bootOwnerDatabaseWithFallback({
      databaseUrl: "postgres://owner/test",
      services: {},
      initialize: async (services) => {
        services.appDb = { destroy: async () => { order.push("pool"); } };
        services.canvasRepository = { destroy: async () => { order.push("canvas"); } };
        services.chatRepository = { release: async () => { order.push("chat"); } };
        services.chatEventStream = { shutdown: () => { order.push("stream"); } };
        throw new Error("private database failure");
      },
      warn,
    });
    expect(result).toEqual({ services: null, failureReason: "owner_database_missing" });
    expect(order).toEqual(["stream", "chat", "canvas", "pool"]);
    expect(warn).toHaveBeenCalledWith("OwnerDatabaseStartupFailure", expect.any(Error));
  });

  it("returns a complete service bag and does not drain it on success", async () => {
    const release = vi.fn(async () => undefined);
    const result = await bootOwnerDatabaseWithFallback({
      databaseUrl: "postgres://owner/test",
      services: {},
      initialize: async (services) => {
        services.chatRepository = { release };
      },
    });
    expect(result.services?.chatRepository).toBeDefined();
    expect(result.failureReason).toBeNull();
    expect(release).not.toHaveBeenCalled();
  });

  it("does not enter database construction when the owner URL is absent", async () => {
    const initialize = vi.fn();
    const result = await bootOwnerDatabaseWithFallback({ services: {}, initialize });
    expect(result).toEqual({ services: null, failureReason: "owner_database_missing" });
    expect(initialize).not.toHaveBeenCalled();
  });
});
