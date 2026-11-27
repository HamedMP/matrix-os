import { generateKeyPairSync, randomBytes } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDesktopLinkService, type DesktopLinkServiceOptions, type DesktopLinkSocket } from "../../desktop/src/main/desktop-link/service";

async function fixture(readInventory: NonNullable<DesktopLinkServiceOptions["readInventory"]>, now?: () => number) {
  const urls: string[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const socket: DesktopLinkSocket = {
    binaryType: "", bufferedAmount: 0, onopen: null, onclose: null, onmessage: null, onerror: null, close: vi.fn(),
    send: (data) => { if (typeof data === "string") frames.push(JSON.parse(data)); },
  };
  const machineId = "5e6b2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
  const service = createDesktopLinkService({
    pairing: { linkIdentity: async () => ({
      origin: "https://paired.test", machineId, ownerId: "owner", revision: 1,
      deviceId: "e".repeat(64), privateKey: generateKeyPairSync("ed25519").privateKey,
    }) },
    now, home: "/test", deviceName: "Mac", app: { os: "macOS", version: "1" }, readInventory,
    openCore: async () => { throw new Error("inventory must not open a control stream"); },
    preferences: { load: async () => ({ computers: {} }), save: async () => undefined },
    createSocket: (url) => { urls.push(url); return socket; }, credential: async () => "fixture",
    consent: { ask: async () => false, fullAccess: async () => false },
  });
  await service.start();
  await service.enable("primary", "test");
  const receive = (frame: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(frame) });
  const challenge = () => receive({ t: "challenge", machineId, nonce: randomBytes(32).toString("base64url") });
  return { service, urls, frames, challenge, receive };
}

it("keeps old gateways on ordinary heartbeat and never reads inventory without a negotiated ready", async () => {
  const readInventory = vi.fn(async () => ({ machines: [], partial: false }));
  const { service, urls, frames, challenge, receive } = await fixture(readInventory);
  try {
    expect(new URL(urls[0]!).searchParams.get("herdrInventory")).toBe("1");
    challenge();
    receive({ t: "ready" });
    receive({ t: "ping" });
    expect(readInventory).not.toHaveBeenCalled();
    expect(frames.at(-1)).toEqual({ t: "pong" });
  } finally { service.dispose(); }
});

it("requires proof, rate-limits concurrent reads and discards a snapshot that resolves after Stop", async () => {
  let finish!: (value: { machines: []; partial: boolean }) => void;
  const readInventory = vi.fn(() => new Promise<{ machines: []; partial: boolean }>((resolve) => { finish = resolve; }));
  const premature = await fixture(readInventory);
  try {
    premature.receive({ t: "ready", herdrInventory: true });
    expect(readInventory).not.toHaveBeenCalled();
  } finally { premature.service.dispose(); }
  const { service, frames, challenge, receive } = await fixture(readInventory);
  try {
    challenge();
    receive({ t: "ready", herdrInventory: true });
    receive({ t: "ping" });
    receive({ t: "ping" });
    expect(readInventory).toHaveBeenCalledTimes(1);
    await service.disable("primary");
    const count = frames.length;
    finish({ machines: [], partial: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(frames).toHaveLength(count);
  } finally { service.dispose(); }
});

it("expires a previously good snapshot when the next read is still pending", async () => {
  const result = { machines: [{ name: "peer", state: "connected" as const }], partial: false };
  let clock = 0;
  let finish!: (value: typeof result) => void;
  const readInventory = vi.fn(async () => result).mockImplementationOnce(async () => result)
    .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const { service, frames, challenge, receive } = await fixture(readInventory, () => clock);
  try {
    challenge();
    receive({ t: "ready", herdrInventory: true });
    await vi.waitFor(() => expect(frames.at(-1)).toEqual({ t: "pong", herdrMachines: result.machines }));
    clock = 20_000;
    receive({ t: "ping" });
    clock = 46_000;
    receive({ t: "ping" });
    expect(readInventory).toHaveBeenCalledTimes(2);
    expect(frames.at(-1)).toEqual({ t: "pong", herdrMachinesPartial: true });
  } finally {
    service.dispose();
    finish?.(result);
  }
});
