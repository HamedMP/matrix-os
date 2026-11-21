import { Hono } from "hono";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OwnerLoginStore,
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
