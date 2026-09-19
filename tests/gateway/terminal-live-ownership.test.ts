import { describe, expect, it, vi } from "vitest";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";

const KEY = "owner:tws_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:tt_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("terminal live ownership", () => {
  it("demotes the previous writer without disconnecting its observer stream", () => {
    const ownership = createTerminalLiveOwnership();
    const firstRevoked = vi.fn();
    const secondRevoked = vi.fn();

    ownership.attach({ key: KEY, viewerId: "web", exclusive: true, onRevoked: firstRevoked });
    expect(ownership.role(KEY, "web")).toBe("writer");

    ownership.attach({ key: KEY, viewerId: "electron", exclusive: true, onRevoked: secondRevoked });

    expect(firstRevoked).toHaveBeenCalledOnce();
    expect(secondRevoked).not.toHaveBeenCalled();
    expect(ownership.role(KEY, "web")).toBe("observer");
    expect(ownership.role(KEY, "electron")).toBe("writer");
    expect(ownership.allowsMutation(KEY, "web")).toBe(false);
    expect(ownership.allowsMutation(KEY, "electron")).toBe(true);
  });

  it("keeps observers read-only after the writer leaves until one explicitly reclaims", () => {
    const ownership = createTerminalLiveOwnership();
    ownership.attach({ key: KEY, viewerId: "web", exclusive: true, onRevoked: vi.fn() });
    ownership.attach({ key: KEY, viewerId: "electron", exclusive: true, onRevoked: vi.fn() });

    ownership.detach(KEY, "electron");
    expect(ownership.role(KEY, "web")).toBe("observer");
    expect(ownership.allowsMutation(KEY, "web")).toBe(false);

    ownership.claim(KEY, "web");
    expect(ownership.role(KEY, "web")).toBe("writer");
    expect(ownership.allowsMutation(KEY, "web")).toBe(true);
  });

  it("preserves an explicitly observing reconnect when no writer is currently registered", () => {
    const ownership = createTerminalLiveOwnership();
    ownership.attach({
      key: KEY,
      viewerId: "reconnected-observer",
      exclusive: false,
      observe: true,
      onRevoked: vi.fn(),
    });

    expect(ownership.role(KEY, "reconnected-observer")).toBe("observer");
    expect(ownership.allowsMutation(KEY, "reconnected-observer")).toBe(false);
  });

  it("caps viewers per terminal and drains callbacks on shutdown", () => {
    const ownership = createTerminalLiveOwnership({ maxViewersPerTerminal: 1 });
    const revoked = vi.fn();
    ownership.attach({ key: KEY, viewerId: "web", exclusive: true, onRevoked: revoked });

    expect(() => ownership.attach({
      key: KEY,
      viewerId: "electron",
      exclusive: false,
      onRevoked: vi.fn(),
    })).toThrow("busy");

    ownership.close();
    expect(revoked).toHaveBeenCalledOnce();
    expect(ownership.role(KEY, "web")).toBe("observer");
  });
});
