import { Hono } from "hono";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OwnerLoginStore,
  createOwnerLoginLearner,
  evaluateTailscaleIdentity,
  privateNetworkIdentityMiddleware,
  readPrivateNetworkIdentity,
} from "../../packages/gateway/src/private-network/identity.js";

// Spec 2701: the gateway trusts `Tailscale-User-Login` only from the loopback
// serve proxy and only when it equals the owner login recorded at install.
describe("Tailscale identity trust", () => {
  const owner = "alice@example.com";

  it("trusts the header only on loopback and only for the recorded owner", () => {
    const base = { accessMode: "tailscale" as const, ownerLogin: owner };
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "127.0.0.1", headerLogin: owner })).toBe("owner");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "::ffff:127.0.0.1", headerLogin: owner })).toBe("owner");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "100.64.0.9", headerLogin: owner })).toBe("rejected");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: undefined, headerLogin: owner })).toBe("rejected");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "127.0.0.1", headerLogin: "mallory@example.com" })).toBe("rejected");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "127.0.0.1", headerLogin: `${owner} ` })).toBe("rejected");
    expect(evaluateTailscaleIdentity({ ...base, ownerLogin: null, remoteAddress: "127.0.0.1", headerLogin: owner })).toBe("rejected");
    expect(evaluateTailscaleIdentity({ ...base, remoteAddress: "127.0.0.1", headerLogin: undefined })).toBe("none");
  });

  it("never grants identity from the header on public installs", () => {
    expect(evaluateTailscaleIdentity({ accessMode: "public", ownerLogin: owner, remoteAddress: "127.0.0.1", headerLogin: owner })).toBe("none");
    expect(evaluateTailscaleIdentity({ accessMode: null, ownerLogin: owner, remoteAddress: "127.0.0.1", headerLogin: owner })).toBe("none");
  });

  function appWith(remoteAddress: string, ownerLogin: string | null, accessMode: "tailscale" | "public" = "tailscale") {
    const app = new Hono();
    app.use("*", privateNetworkIdentityMiddleware({
      accessMode,
      ownerLogin: async () => ownerLogin,
      remoteAddress: () => remoteAddress,
    }));
    app.get("/probe", (c) => c.json({ owner: readPrivateNetworkIdentity(c) }));
    return app;
  }

  it("rejects a forged or foreign identity before any route runs", async () => {
    const forged = await appWith("10.0.0.5", owner).request("/probe", { headers: { "Tailscale-User-Login": owner } });
    expect(forged.status).toBe(403);
    expect(await forged.text()).not.toContain(owner);
    const foreign = await appWith("127.0.0.1", owner).request("/probe", { headers: { "Tailscale-User-Login": "bob@example.com" } });
    expect(foreign.status).toBe(403);
    const unrecorded = await appWith("127.0.0.1", null).request("/probe", { headers: { "Tailscale-User-Login": owner } });
    expect(unrecorded.status).toBe(403);
  });

  it("marks owner requests and leaves header-less local callers to bearer auth", async () => {
    const ownerRequest = await appWith("127.0.0.1", owner).request("/probe", { headers: { "Tailscale-User-Login": owner } });
    expect(await ownerRequest.json()).toEqual({ owner: true });
    const local = await appWith("127.0.0.1", owner).request("/probe");
    expect(await local.json()).toEqual({ owner: false });
    const publicInstall = await appWith("127.0.0.1", owner, "public").request("/probe", { headers: { "Tailscale-User-Login": "anyone@example.com" } });
    expect(await publicInstall.json()).toEqual({ owner: false });
  });

  describe("owner learned after a post-install sign-in", () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "matrix-private-network-learn-"));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    function learningApp(remoteAddress: string, selfLogin: string | null, connected = true) {
      const store = new OwnerLoginStore({ homePath: home, installLogin: null });
      let statusCalls = 0;
      const learn = createOwnerLoginLearner({
        ownerLogins: store,
        status: async () => {
          statusCalls += 1;
          return { state: connected ? "connected" as const : "needs-login" as const, ownerLogin: selfLogin };
        },
      });
      const app = new Hono();
      app.use("*", privateNetworkIdentityMiddleware({
        accessMode: "tailscale",
        ownerLogin: () => store.get(),
        learnOwnerLogin: learn,
        remoteAddress: () => remoteAddress,
      }));
      app.get("/probe", (c) => c.json({ owner: readPrivateNetworkIdentity(c) }));
      return { app, store, statusCalls: () => statusCalls };
    }

    it("records this machine's own login on the first owner request instead of locking the owner out", async () => {
      const { app, store } = learningApp("127.0.0.1", owner);
      const first = await app.request("/probe", { headers: { "Tailscale-User-Login": owner } });
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ owner: true });
      expect(await store.get()).toBe(owner);
    });

    it("still rejects a different login, a non-loopback peer and a machine that is not signed in", async () => {
      const foreign = learningApp("127.0.0.1", owner);
      expect((await foreign.app.request("/probe", { headers: { "Tailscale-User-Login": "bob@example.com" } })).status).toBe(403);
      // The machine's own login is recorded even though this request was not the owner's.
      expect(await foreign.store.get()).toBe(owner);

      await rm(home, { recursive: true, force: true });
      const remote = learningApp("100.64.0.9", owner);
      expect((await remote.app.request("/probe", { headers: { "Tailscale-User-Login": owner } })).status).toBe(403);
      expect(remote.statusCalls()).toBe(0);
      expect(await remote.store.get()).toBeNull();

      const signedOut = learningApp("127.0.0.1", owner, false);
      expect((await signedOut.app.request("/probe", { headers: { "Tailscale-User-Login": owner } })).status).toBe(403);
      expect(await signedOut.store.get()).toBeNull();
    });

    it("reads Tailscale once for concurrent first requests", async () => {
      const { app, statusCalls } = learningApp("127.0.0.1", owner);
      const responses = await Promise.all([1, 2, 3].map(() => app.request("/probe", { headers: { "Tailscale-User-Login": owner } })));
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(statusCalls()).toBe(1);
    });
  });

  describe("owner login store", () => {
    let home: string;
    beforeEach(async () => {
      home = await mkdtemp(join(tmpdir(), "matrix-private-network-"));
    });
    afterEach(async () => {
      await rm(home, { recursive: true, force: true });
    });

    it("prefers the install-time login and never replaces a recorded one", async () => {
      const fromInstall = new OwnerLoginStore({ homePath: home, installLogin: owner });
      expect(await fromInstall.get()).toBe(owner);
      expect(await fromInstall.recordIfMissing("mallory@example.com")).toBe(owner);

      const store = new OwnerLoginStore({ homePath: home, installLogin: null });
      expect(await store.get()).toBeNull();
      expect(await store.recordIfMissing(owner)).toBe(owner);
      expect(await store.recordIfMissing("mallory@example.com")).toBe(owner);
      const reloaded = new OwnerLoginStore({ homePath: home, installLogin: null });
      expect(await reloaded.get()).toBe(owner);
      const file = await readFile(join(home, "system", "private-network", "owner.json"), "utf8");
      expect(JSON.parse(file)).toMatchObject({ login: owner });
    });

    it("refuses logins that are not plain Tailscale login names", async () => {
      const store = new OwnerLoginStore({ homePath: home, installLogin: null });
      await expect(store.recordIfMissing("alice\nadmin")).rejects.toThrow();
      expect(new OwnerLoginStore({ homePath: home, installLogin: "bad login" }).installLogin).toBeNull();
    });
  });
});
