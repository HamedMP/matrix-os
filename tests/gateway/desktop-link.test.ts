// Desktop link gateway side (spec 2716): admission over 2698 pairing, the owner-only
// auth matrix, link proofs, revocation by pairing revision, last seen (D3), and a
// real herdr-core conversation carried over the link to a desktop stand-in.
import { once } from "node:events";
import { sql } from "kysely";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { DESKTOP_LINK_CLOSE, DesktopLinkMachineListSchema } from "@matrix-os/contracts/desktop-link";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { DesktopPairingRepository } from "../../packages/gateway/src/desktop-pairing/database.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, db, dialMac, gateway, MACHINE, OWNER, ownerHeaders, pair, SECRET, testMac, unpair } from "./fixtures/desktop-link-harness.js";

const listed = async (http: Awaited<ReturnType<typeof gateway>>["http"]) =>
  DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json()).machines;

describe("Pairing is the desktop link's admission (2698)", () => {
  it("lists the paired desktop offline until it links, and nothing before pairing", async () => {
    const { http } = await gateway();
    const mac = testMac();
    expect(await listed(http)).toEqual([]);
    expect((await pair(http, mac)).status).toBe(200);
    expect(await listed(http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 1, state: "offline", lastSeenAt: null }]);
  });

  it("admits only the paired device, at exactly the current pairing revision", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const unpaired = dialMac(base, mac, { revision: 1 });
    await unpaired.closed();
    expect(unpaired.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    await pair(http, mac);
    const other = dialMac(base, testMac(), { revision: 1 });
    await other.closed();
    expect(other.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
  });

  it("negotiates inventory only with the opted-in paired Desktop and drops it on reconnect", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const legacy = dialMac(base, mac, { revision: 1 });
    await legacy.ready();
    expect(legacy.control.find((frame) => frame.t === "ready")).toEqual({ t: "ready" });
    const modern = dialMac(base, mac, { revision: 1, herdrInventory: true });
    await modern.ready();
    expect(modern.control.find((frame) => frame.t === "ready")).toEqual({ t: "ready", herdrInventory: true });
    const rows = [{ name: "dev.build", state: "unknown" }];
    modern.socket.send(JSON.stringify({ t: "pong", herdrMachines: rows, herdrMachinesPartial: true }));
    await modern.until(() => registry?.linked()[0]?.herdrMachinesPartial === true);
    expect((await registry?.chatLease(mac.deviceId))?.herdrMachines()).toEqual(rows);
    const next = dialMac(base, mac, { revision: 1 });
    await next.ready();
    expect(registry?.linked()[0]?.herdrMachines).toBeUndefined();
    next.socket.send(JSON.stringify({ t: "pong", herdrMachines: rows }));
    await next.closed();
    expect(next.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  // Fault detected: a disconnect (or Remove on the computer) left a live link
  // working until it dropped by itself, so a revoked desktop kept running terminals.
  it("ends the live link the moment the pairing is disconnected, and refuses it after", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect((await unpair(http, mac, 1)).status).toBe(200);
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(link.control.some((frame) => frame.t === "bye" && frame.reason === "removed")).toBe(true);
    expect(registry?.online(mac.deviceId)).toBe(false);
    for (const revision of [1, 2]) {
      const retry = dialMac(base, mac, { revision });
      await retry.closed();
      expect(retry.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    }
    expect(await (await pair(http, mac, 2)).json()).toMatchObject({ deviceId: mac.deviceId, revision: 3 });
    const again = dialMac(base, mac, { revision: 3 });
    await again.ready();
  });

  // Fault detected (review): a disconnect that committed while the link's proof key was
  // being read still admitted the link, since the change notice only ends admitted links.
  it("refuses a link whose pairing changed while its proof was being checked", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    const original = DesktopPairingRepository.prototype.readRegisteredKey;
    const spy = vi.spyOn(DesktopPairingRepository.prototype, "readRegisteredKey").mockImplementation(async function (this: DesktopPairingRepository, ...args) {
      const key = await original.apply(this, args);
      reading = true;
      await gate;
      return key;
    });
    const link = dialMac(base, mac, { revision: 1 });
    await link.until(() => reading);
    expect((await unpair(http, mac, 1)).status).toBe(200);
    release();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(registry?.online(mac.deviceId)).toBe(false);
    spy.mockRestore();
  });

  it("ends a live link whose pairing changed without a notice, within a few heartbeats", async () => {
    const now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 3_600_000, staleMs: 3_600_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    await db.updateTable("desktop_pairings").set({ device_id: null, public_key: null, revision: 2 }).execute();
    for (let beat = 0; beat < 4; beat += 1) registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
  });

  it("refuses a link whose pairing changed without a notice, before its next core stream", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core: createFakeHerdrCore() });
    await link.ready();
    // As if another gateway process disconnected it: the row changed, no notice came.
    await db.updateTable("desktop_pairings").set({ device_id: null, public_key: null, revision: 2 }).execute();
    const listing = await registry!.adapter(mac.deviceId)!.list();
    expect(listing.status).not.toBe("ready");
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
  });
});

describe("Desktop link auth matrix", () => {
  // Fault detected (review): the machine list took the bare gateway token, which
  // 2698's pairing routes refuse, so a client that could list a desktop got 403 on Remove.
  it("answers the same principals as 2698's pairing routes", async () => {
    const { http } = await gateway();
    const shell = { authorization: `Bearer ${SECRET}` };
    expect((await http("/api/desktop-link/machines", {}, shell)).status).toBe(403);
    expect((await http("/api/desktop-pairing", {}, shell)).status).toBe(403);
    expect((await http("/api/desktop-link/machines")).status).toBe(200);
    expect((await http("/api/desktop-pairing")).status).toBe(200);
  });

  it("refuses everyone but the owner on the machine list, and only a signed-in desktop opens the link", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    expect((await http("/api/desktop-link/machines", {}, {})).status).toBe(401);
    expect((await http("/api/desktop-link/machines", {}, ownerHeaders("org_member"))).status).toBe(403);
    await pair(http, mac);
    for (const headers of [{}, ownerHeaders("org_member"), { authorization: `Bearer ${SECRET}` }]) {
      const link = dialMac(base, mac, { revision: 1, headers });
      await link.closed();
      expect(link.upgradeStatus()).not.toBeNull();
    }
  });

  it("is absent when switched off and unavailable without the owner database", async () => {
    expect((await (await gateway({ enabled: false })).http("/api/desktop-link/machines")).status).toBe(404);
    expect((await (await gateway({ ownerDatabase: null })).http("/api/desktop-link/machines")).status).toBe(503);
  });
});

describe("Desktop link admission", () => {
  it("admits the paired desktop with a fresh proof and shows it online", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect(registry?.online(mac.deviceId)).toBe(true);
    expect((await listed(http))[0]?.state).toBe("online");
  });

  it("closes a link whose proof is wrong, stale, for another computer or not a proof", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const stranger = testMac();
    await pair(http, mac);
    const attempts = [
      dialMac(base, mac, { revision: 2 }),
      dialMac(base, stranger, { revision: 1 }),
      dialMac(base, mac, { revision: 1, proof: (nonce) => ({
        t: "proof", name: "x", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1, "00000000-0000-4000-8000-000000000000"),
        app: { version: "0.9.0", os: "macOS" },
      }) }),
    ];
    for (const attempt of attempts) {
      await attempt.closed();
      expect(attempt.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    }
    const garbage = dialMac(base, mac, { revision: 1, proof: () => ({ t: "hello" }) });
    await garbage.closed();
    expect(garbage.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("refuses a self-reported name with control characters", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, proof: (nonce) => ({
      t: "proof", name: "Mac\u0007", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1), app: { version: "0.9.0", os: "macOS" },
    }) });
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("refuses binary bytes before admission", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: ownerHeaders() });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(Buffer.from([1, 2, 3]));
    const [code] = await once(socket, "close") as [number];
    expect(code).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("replaces an older link for the same desktop", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const first = dialMac(base, mac, { revision: 1 });
    await first.ready();
    const second = dialMac(base, mac, { revision: 1 });
    await second.ready();
    await first.closed();
    expect(first.closeCode()).toBe(DESKTOP_LINK_CLOSE.replaced);
    expect(registry?.online(mac.deviceId)).toBe(true);
  });

  it("closes a link that stops answering", async () => {
    let now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 60_000, staleMs: 45_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    now += 46_000;
    registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.going);
    expect(registry.online(mac.deviceId)).toBe(false);
  });
});

// D3 (Hamed, 2026-11-25): the paired desktop's name and last seen live on 2698's row.
describe("The paired desktop's name and last seen", () => {
  it("stores the name for the paired device at its revision, keeps it across a restart, and clears it on disconnect and re-pair", async () => {
    const first = await gateway();
    const mac = testMac();
    await pair(first.http, mac);
    const link = dialMac(first.base, mac, { revision: 1 });
    await link.ready();
    await expect.poll(async () => (await listed(first.http))[0]?.name).toBe("Hamed's MacBook");
    link.socket.terminate();
    await link.closed();
    // A new gateway process on the same database still knows it, offline.
    const restarted = await gateway();
    expect(await listed(restarted.http)).toMatchObject([{ name: "Hamed's MacBook", state: "offline", lastSeenAt: expect.any(String) }]);
    expect((await unpair(restarted.http, mac, 1)).status).toBe(200);
    await pair(restarted.http, mac, 2);
    expect(await listed(restarted.http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 3, state: "offline", lastSeenAt: null }]);
  });

  it("writes last seen on admission, then at most once a minute while the desktop stays linked", async () => {
    let now = Date.parse("2026-11-25T10:00:00.000Z");
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 3_600_000, staleMs: 3_600_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    const lastSeen = async () => (await db.selectFrom("desktop_pairings").select("last_seen_at").executeTakeFirstOrThrow()).last_seen_at;
    await expect.poll(async () => (await lastSeen())?.toISOString()).toBe("2026-11-25T10:00:00.000Z");
    const touches = vi.spyOn(DesktopPairingRepository.prototype, "touch");
    for (let beat = 0; beat < 3; beat += 1) { now += 15_000; registry.sweep(); }
    expect(touches).not.toHaveBeenCalled();
    now += 20_000;
    registry.sweep();
    await expect.poll(async () => (await lastSeen())?.toISOString()).toBe("2026-11-25T10:01:05.000Z");
    expect(touches).toHaveBeenCalledTimes(1);
    touches.mockRestore();
  });

  it("adds the D3 columns to a table 2698 created before them, keeping its pairing", async () => {
    await sql`CREATE TABLE desktop_pairings (
      owner_id TEXT NOT NULL, machine_id UUID NOT NULL, device_id TEXT, public_key TEXT,
      revision BIGINT NOT NULL, PRIMARY KEY (owner_id, machine_id))`.execute(db);
    const mac = testMac();
    await db.insertInto("desktop_pairings").values({
      owner_id: OWNER, machine_id: MACHINE, device_id: mac.deviceId, public_key: mac.publicKey, revision: 4,
    } as never).execute();
    const { http, base } = await gateway();
    expect(await listed(http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 4, state: "offline", lastSeenAt: null }]);
    const link = dialMac(base, mac, { revision: 4 });
    await link.ready();
    await expect.poll(async () => (await listed(http))[0]?.name).toBe("Hamed's MacBook");
  });
});

describe("Herdr over the Desktop link", () => {
  it("drops desktop bytes that arrive before the desktop acknowledges the new stream", async () => {
    const registry = createDesktopLinkRegistry({ createAdapter: (open) => createHerdrAdapter({ open }) });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "shell" });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core, staleBytes: true });
    await link.ready();
    const listed = await registry.adapter(mac.deviceId)!.list();
    expect(listed.status).toBe("ready");
    expect(listed.sessions.map((session) => session.id)).toEqual(["t1"]);
  });

  it("lists and attaches the desktop's terminals through the link, and reports the desktop gone when it drops", async () => {
    const registry = createDesktopLinkRegistry({
      createAdapter: (open) => createHerdrAdapter({ open, captureQuietMs: 5, captureMaxMs: 100 }),
    });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "claude on the desktop", status: { state: "working" }, screen: "hello from darwin" });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core });
    await link.ready();

    const adapter = registry.adapter(mac.deviceId);
    expect(adapter).not.toBeNull();
    const listed = await adapter!.list();
    expect(listed.status).toBe("ready");
    expect(listed.sessions).toMatchObject([{ id: "t1", title: "claude on the desktop", status: "working" }]);

    const output: string[] = [];
    let ended: string | null = null;
    const attachment = await adapter!.attach("t1", { cols: 80, rows: 24 }, {
      output: (data, consumed) => { output.push(data); consumed(); },
      closed: (reason) => { ended = reason; },
    }, { observe: true });
    await link.until(() => output.join("").includes("hello from darwin"));
    core.output("t1", "more output");
    await link.until(() => output.join("").includes("more output"));

    link.socket.terminate();
    await link.until(() => ended !== null);
    expect(ended).toBe("disconnected");
    expect(registry.adapter(mac.deviceId)).toBeNull();
    attachment.detach();
  });
});

// Fault detected (review): an adapter outlived its desktop going offline, and replacing
// that desktop with another left it open, so adapters piled up past the link cap.
describe("Desktop link registry adapters", () => {
  function fakeLink(deviceId: string, revision: number) {
    let closed = false;
    return {
      info: { deviceId, revision } as never,
      get closed() { return closed; },
      lastSeen: () => Date.now(),
      openStream: async () => { throw new Error("unused"); },
      receiveControl: () => {}, receiveBinary: () => {}, send: () => {},
      closedBy: () => { closed = true; },
      close: () => { closed = true; },
    };
  }

  it("closes the adapter of a desktop that went offline once another desktop links or the pairing moves on", () => {
    const closedAdapters: string[] = [];
    let made = 0;
    const registry = createDesktopLinkRegistry({
      maxLinks: 1,
      createAdapter: () => { const id = `a${made++}`; return { close: () => closedAdapters.push(id) } as never; },
    });
    const first = fakeLink("desktop-a", 1);
    expect(registry.admit(first as never)).toBe(true);
    registry.closed(first as never);
    expect(closedAdapters).toEqual([]);
    expect(registry.admit(fakeLink("desktop-b", 2) as never)).toBe(true);
    expect(closedAdapters).toEqual(["a0"]);
    registry.closed(fakeLink("desktop-b", 2) as never);
    registry.pairingChanged({ deviceId: null, revision: 3 });
    expect(closedAdapters).toEqual(["a0", "a1"]);
    void registry.drain();
  });
});
