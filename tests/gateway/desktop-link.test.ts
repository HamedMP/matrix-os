// Desktop link gateway side (spec 2716): enrolment, the owner-only auth matrix,
// link admission with device proofs, revocation and replacement, and a real
// herdr-core conversation carried over the link to a desktop stand-in.
import { once } from "node:events";
import { WebSocket } from "ws";
import { describe, expect, it } from "vitest";
import { DESKTOP_LINK_CLOSE, DesktopLinkEnrolChallengeSchema, DesktopLinkMachineListSchema, desktopLinkRevisionTag } from "@matrix-os/contracts/desktop-link";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, dialMac, enrol, gateway, MACHINE, ownerHeaders, SECRET, testMac } from "./fixtures/desktop-link-harness.js";

describe("Desktop link enrolment", () => {
  it("enrols a desktop for the owner and lists it offline until it links", async () => {
    const { http } = await gateway();
    const mac = testMac();
    const response = await enrol(http, mac);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: mac.deviceId, revision: 1, machineId: MACHINE });
    const list = DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json());
    expect(list.machines).toMatchObject([{ deviceId: mac.deviceId, name: "Hamed's MacBook", revision: 1, state: "offline", lastSeenAt: null }]);
  });

  it("refuses a proof signed for another owner, a reused challenge and a second live enrolment", async () => {
    const { http } = await gateway();
    const mac = testMac();
    const first = DesktopLinkEnrolChallengeSchema.parse(await (await http("/api/desktop-link/enrol/challenge", {
      method: "POST", body: JSON.stringify({ deviceId: mac.deviceId }),
    })).json());
    const forged = await http("/api/desktop-link/enrol", { method: "POST", body: JSON.stringify({
      nonce: first.nonce, publicKey: mac.publicKey, signature: mac.signEnrol(first.nonce, "someone_else"), name: "desktop",
    }) });
    expect(forged.status).toBe(403);
    // The challenge was consumed by the failed attempt.
    const replay = await http("/api/desktop-link/enrol", { method: "POST", body: JSON.stringify({
      nonce: first.nonce, publicKey: mac.publicKey, signature: mac.signEnrol(first.nonce), name: "desktop",
    }) });
    expect(replay.status).toBe(403);
    expect((await enrol(http, mac)).status).toBe(200);
    expect((await enrol(http, mac)).status).toBe(409);
  });

  it("caps enrolled desktops at five", async () => {
    const { http } = await gateway();
    for (let index = 0; index < 5; index += 1) expect((await enrol(http, testMac(), `desktop ${index}`)).status).toBe(200);
    const sixth = await enrol(http, testMac());
    expect(sixth.status).toBe(409);
    expect(await sixth.json()).toEqual({ error: "too_many" });
  });

  it("removes a desktop only with the current revision tag, then allows a fresh enrolment at a higher revision", async () => {
    const { http } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const path = `/api/desktop-link/machines/${mac.deviceId}`;
    expect((await http(path, { method: "DELETE" })).status).toBe(412);
    expect((await http(path, { method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 2 }) } })).status).toBe(409);
    const removed = await http(path, { method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 1 }) } });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deviceId: mac.deviceId, revision: 2 });
    expect(DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json()).machines).toEqual([]);
    const again = await enrol(http, mac);
    expect(await again.json()).toMatchObject({ revision: 3 });
  });
});

describe("Desktop link auth matrix", () => {
  it("refuses everyone but the owner on every route and on the link upgrade", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const routes: Array<[string, RequestInit]> = [
      ["/api/desktop-link/machines", {}],
      ["/api/desktop-link/enrol/challenge", { method: "POST", body: JSON.stringify({ deviceId: mac.deviceId }) }],
      ["/api/desktop-link/enrol", { method: "POST", body: "{}" }],
      [`/api/desktop-link/machines/${mac.deviceId}`, { method: "DELETE" }],
    ];
    for (const [path, init] of routes) {
      expect((await http(path, init, {})).status, `${path} anonymous`).toBe(401);
      expect((await http(path, init, ownerHeaders("org_member"))).status, `${path} org member`).toBe(403);
      // The gateway's own runtime token with no user named is the configured owner:
      // the computer's own shell proxy sends exactly that, as for Herdr's routes.
      expect((await http(path, init, { authorization: `Bearer ${SECRET}` })).status, `${path} gateway token`).not.toBe(403);
    }
    for (const headers of [{}, ownerHeaders("org_member")]) {
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
  it("admits an enrolled desktop with a fresh proof and shows it online", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect(registry?.online(mac.deviceId)).toBe(true);
    const list = DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json());
    expect(list.machines[0]?.state).toBe("online");
  });

  it("closes a link whose proof is wrong, stale, for another computer or not a proof", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const stranger = testMac();
    await enrol(http, mac);
    const attempts = [
      dialMac(base, mac, { revision: 2 }),
      dialMac(base, stranger, { revision: 1 }),
      dialMac(base, mac, { revision: 1, proof: (nonce) => ({
        t: "proof", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1, "00000000-0000-4000-8000-000000000000"),
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

  it("refuses binary bytes before admission", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: ownerHeaders() });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(Buffer.from([1, 2, 3]));
    const [code] = await once(socket, "close") as [number];
    expect(code).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("replaces an older link for the same desktop, and removal closes the live link at once", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const first = dialMac(base, mac, { revision: 1 });
    await first.ready();
    const second = dialMac(base, mac, { revision: 1 });
    await second.ready();
    await first.closed();
    expect(first.closeCode()).toBe(DESKTOP_LINK_CLOSE.replaced);
    expect(registry?.online(mac.deviceId)).toBe(true);

    const removed = await http(`/api/desktop-link/machines/${mac.deviceId}`, {
      method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 1 }) },
    });
    expect(removed.status).toBe(200);
    await second.closed();
    expect(second.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(second.control.some((frame) => frame.t === "bye" && frame.reason === "removed")).toBe(true);
    expect(registry?.online(mac.deviceId)).toBe(false);
    // The removed revision never links again.
    const retry = dialMac(base, mac, { revision: 1 });
    await retry.closed();
    expect(retry.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
  });

  it("closes a link that stops answering", async () => {
    let now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 60_000, staleMs: 45_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await enrol(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    now += 46_000;
    registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.going);
    expect(registry.online(mac.deviceId)).toBe(false);
  });
});

describe("Herdr over the Desktop link", () => {
  it("drops desktop bytes that arrive before the desktop acknowledges the new stream", async () => {
    const registry = createDesktopLinkRegistry({ createAdapter: (open) => createHerdrAdapter({ open }) });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "shell" });
    const mac = testMac();
    await enrol(http, mac);
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
    await enrol(http, mac);
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
