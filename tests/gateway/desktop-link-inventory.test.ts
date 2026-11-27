import { describe, expect, it, vi } from "vitest";
import { DesktopLinkClientFrameSchema, DESKTOP_LINK_CLOSE } from "@matrix-os/contracts/desktop-link";
import { createDesktopLink } from "../../packages/gateway/src/desktop-link/link.js";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";

const deviceId = "ab".repeat(32);
const row = { name: "build.dev", state: "unreachable" } as const;

function mac(now: () => number, herdrInventory = true) {
  return createDesktopLink({
    now, herdrInventory,
    info: { deviceId, revision: 1, name: "Mac", appVersion: "1", os: "macOS" },
    transport: { sendText: vi.fn(), sendBinary: vi.fn(), bufferedAmount: () => 0, close: vi.fn() },
  });
}

describe("Paired desktop discovery", () => {
  it("only carries bounded display metadata and keeps Core and Matrix aliases distinct", () => {
    const matrix = { name: "build-dev", state: "unknown", source: "matrix" };
    const rows = [
      { ...row, name: matrix.name },
      { ...matrix, runtimeSlot: "dev" },
      { ...matrix, runtimeSlot: "pr-89" },
    ];
    const pong = { t: "pong", herdrMachines: rows, herdrMachinesPartial: true };
    expect(DesktopLinkClientFrameSchema.parse(pong)).toEqual(pong);
    const invalidRows = [
      Array(33).fill(row),
      [{ ...row, sshTarget: "ssh-host" }],
      [{ ...row, name: "bad\nname" }],
      [{ ...row, source: "spoofed" }],
      [matrix],
      [{ ...matrix, runtimeSlot: "not_a_slot" }],
      [{ ...row, runtimeSlot: "dev" }],
    ];
    for (const herdrMachines of invalidRows) {
      expect(DesktopLinkClientFrameSchema.safeParse({ ...pong, herdrMachines }).success).toBe(false);
    }
  });

  it("expires an inventory independently of traffic and fences replacement, disconnect and pairing changes", async () => {
    let at = 0;
    const registry = createDesktopLinkRegistry({ pairing: async () => ({ deviceId, revision: 1 }) });
    try {
      const first = mac(() => at);
      registry.admit(first);
      const lease = (await registry.chatLease(deviceId))!;
      const pong = { t: "pong", herdrMachines: [row], herdrMachinesPartial: true } as const;
      const publish = () => first.receiveControl(DesktopLinkClientFrameSchema.parse(pong));
      publish();
      expect(lease.herdrMachines()).toEqual([row]);
      expect(lease.herdrMachinesPartial()).toBe(true);
      at += 61_000;
      first.receiveControl({ t: "ping" });
      expect(lease.herdrMachines()).toBeUndefined();
      publish();
      first.receiveControl({ t: "pong" });
      expect(lease.herdrMachines()).toBeUndefined();
      publish();
      const second = mac(() => at);
      registry.admit(second);
      expect(lease.herdrMachines()).toBeUndefined();
      expect(registry.linked()[0]?.herdrMachines).toBeUndefined();
      second.receiveControl({ t: "pong", herdrMachines: [] });
      expect((await registry.chatLease(deviceId))?.herdrMachines()).toEqual([]);
      registry.pairingChanged({ deviceId: null, revision: 2 });
      expect(registry.linked()).toEqual([]);
    } finally {
      await registry.drain();
    }
  });

  it("preserves the connection and clears old rows when every inventory source fails", () => {
    const link = mac(() => 0);
    link.receiveControl({ t: "pong", herdrMachines: [row] });
    link.receiveControl({ t: "pong", herdrMachinesPartial: true });
    expect(link.closed).toBe(false);
    expect(link.inventory()).toEqual({ herdrMachinesPartial: true });
  });

  it("requires inventory negotiation before accepting rows", () => {
    const legacy = mac(() => 0, false);
    legacy.receiveControl({ t: "pong" });
    expect(legacy.closed).toBe(false);
    legacy.receiveControl({ t: "pong", herdrMachines: [row] });
    expect(legacy.closed).toBe(true);
  });

  it("displays only the current offline pairing and invalidates it when the desktop appears or is removed", async () => {
    const registry = createDesktopLinkRegistry();
    let state: { deviceId: string | null; revision: number } = { deviceId, revision: 1 };
    registry.usePairing(async () => state, async () => "My Mac");
    try {
      const offline = (await registry.pairedOffline())!;
      expect(offline.name).toBe("My Mac");
      expect(offline.current()).toBe(true);
      const first = mac(() => 0);
      registry.admit(first);
      expect(offline.current()).toBe(false);
      expect(await registry.pairedOffline()).toBeNull();
      first.close(DESKTOP_LINK_CLOSE.going);
      state = { deviceId: null, revision: 2 };
      registry.pairingChanged(state);
      expect(offline.current()).toBe(false);
      expect(await registry.pairedOffline()).toBeNull();
    } finally {
      await registry.drain();
    }
  });
});
