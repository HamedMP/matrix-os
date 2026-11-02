import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore } from "@desktop/main/persistence/local-store";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "@desktop/main/auth/auth-service";
import { verifyDesktopPreviewContext } from "@desktop/main/preview-pair-context";
import { issuePreviewPairLaunch } from "../../packages/platform/src/preview-pair/launch-proof.js";
import { PAIR_NOW, previewPairManifestFixture } from "../platform/preview-pair-test-support.js";
async function fixture(cached = true, fault?: string, persistedDir?: string) {
  const proof = issuePreviewPairLaunch({ manifest: previewPairManifestFixture(), role: "owner", platform: "darwin", arch: "arm64", sourceOrigin: "https://app.matrix-os.com" }, "s".repeat(40), PAIR_NOW);
  const context = (await verifyDesktopPreviewContext(JSON.stringify(proof), { buildSource: { commit: proof.context.sourceSha, ancestors: [] },
    platform: "darwin", arch: "arm64", now: () => PAIR_NOW, fetchFn: async () => Response.json({ valid: true }) }))!;
  const binding = { pairId: context.pairId, generation: context.generation, sourceSha: context.sourceSha, role: context.role,
    actorId: context.actorId, machineId: context.machineId, organizationId: context.organizationId, authorityGeneration: context.authorityGeneration };
  const profile: any = { handle: context.handle, userId: context.actorId, platformHost: context.apiOrigin, runtimeSlot: context.runtimeSlot, previewPair: binding };
  const credential = { accessToken: "cached-token", expiresAt: PAIR_NOW + 3_600_000, userId: fault === "actor" ? "user_outsider" : context.actorId, handle: context.handle };
  if (fault === "origin") profile.platformHost = "https://app.matrix-os.com";
  if (fault === "slot") profile.runtimeSlot = "primary";
  if (fault === "machine") profile.previewPair.machineId = "99999999-9999-4999-8999-999999999999";
  if (fault === "generation") profile.previewPair.generation = 2;
  if (fault === "unbound") delete profile.previewPair;
  const store = { load: vi.fn(async () => cached ? credential : null), save: vi.fn(async () => undefined), clear: vi.fn(async () => undefined) };
  const persisted = persistedDir ? createLocalStore({ dir: persistedDir }) : null;
  const saveProfile = vi.fn(async (value: any) => { if (persisted) await persisted.set("profile", value); }), clearProfile = vi.fn(async () => { if (persisted) await persisted.delete("profile"); });
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    expect(new URL(url).origin).toBe(context.apiOrigin);
    if (url.endsWith("/device/code")) {
      return Response.json({ deviceCode: "device-code", userCode: "PAIR-CODE", verificationUri: `${context.browserOrigin}/device`, expiresIn: 900, interval: 1 });
    }
    if (url.endsWith("/device/token")) return Response.json({ accessToken: "new-token".repeat(8), expiresAt: PAIR_NOW + 3_600_000,
      userId: fault === "new actor" ? "user_outsider" : context.actorId, handle: fault === "unselected" || fault === "exchange failed" ? "primary-owner" : context.handle,
      ...(fault === "unselected" || fault === "exchange failed" ? {} : { runtimeSlot: fault === "new slot" ? "primary" : context.runtimeSlot }) });
    if (url.endsWith("/runtime-selection")) {
      expect(JSON.parse(String(init?.body))).toEqual({ slot: context.runtimeSlot });
      if (fault === "exchange failed") return Response.json({ error: "unavailable" }, { status: 503 });
      return Response.json({ accessToken: "selected-token".repeat(8), expiresAt: PAIR_NOW + 3_600_000, handle: context.handle, slot: context.runtimeSlot });
    }
    throw new Error("Unexpected business request");
  });
  const auth = new AuthService({ credentialStore: store, platformHost: context.apiOrigin, runtimeSelectionOrigin: context.apiOrigin,
    previewContext: context, now: () => PAIR_NOW, loadProfile: async () => persisted ? persisted.get("profile") : cached ? profile : null, saveProfile, clearProfile, onAuthChanged: vi.fn(), fetchFn });
  return { auth, context, store, saveProfile, clearProfile, fetchFn };
}
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 0)); }
describe("real AuthService enforces expected preview account and immutable runtime binding", () => {
  it("restores the exact cached role without selecting another computer", async () => {
    const f = await fixture(); await f.auth.init(); expect(f.auth.getToken()).toBe("cached-token");
    expect(f.auth.getStatus()).toMatchObject({ signedIn: true, runtimeSlot: f.context.runtimeSlot, platformHost: f.context.apiOrigin });
    expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["actor", "origin", "slot", "machine", "generation", "unbound"])("drops a mismatching cached %s before any credential use or business request", async fault => {
    const f = await fixture(true, fault); await f.auth.init(); expect(f.auth.getToken()).toBeNull();
    expect(f.auth.getStatus()).toMatchObject({ signedIn: false, runtimeSlot: f.context.runtimeSlot, platformHost: f.context.apiOrigin });
    expect(f.store.clear).toHaveBeenCalled(); expect(f.fetchFn).not.toHaveBeenCalled();
  });
  it.each(["new actor", "new slot", "exchange failed"])("does not persist %s and never falls back to primary", async fault => {
    const f = await fixture(false, fault); await f.auth.init(); await f.auth.startDeviceFlow("sign-in"); await settle();
    expect(f.auth.getToken()).toBeNull(); expect(f.store.save).not.toHaveBeenCalled(); expect(f.saveProfile).not.toHaveBeenCalled();
    expect(f.auth.getStatus().runtimeSlot).toBe(f.context.runtimeSlot);
    if (fault !== "exchange failed") expect(f.auth.poll()).toMatchObject({ status: "expired", reason: "preview_account_mismatch" });
  });
  it("exchanges an unselected normal login only for its expected slot and persists the immutable role binding", async () => {
    const f = await fixture(false, "unselected"); await f.auth.init(); await f.auth.startDeviceFlow("sign-in"); await settle();
    expect(f.auth.getToken()).toBe("selected-token".repeat(8));
    expect(f.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ runtimeSlot: f.context.runtimeSlot,
      previewPair: expect.objectContaining({ pairId: f.context.pairId, machineId: f.context.machineId, role: "owner" }) }));
  });
  it("does not ask the browser to focus the normal app's globally registered callback", async () => {
    const f = await fixture(false); await f.auth.init(); await f.auth.startDeviceFlow("sign-in"); await settle();
    const call = f.fetchFn.mock.calls.find(([url]) => url.endsWith("/device/code"));
    expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("redirectUri");
  });
  it("rejects an explicit computer switch outside the verified slot before network effects", async () => {
    const f = await fixture(); await f.auth.init(); await expect(f.auth.selectRuntime("primary")).rejects.toThrow();
    expect(f.fetchFn).not.toHaveBeenCalled(); expect(f.auth.getToken()).toBe("cached-token");
  });
});

it("keeps a newly signed-in role binding through the real local-store schema and process restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "eng418-auth-restart-"));
  try {
    const first = await fixture(false, undefined, dir);
    await first.auth.init(); await first.auth.startDeviceFlow("sign-in"); await settle();
    expect(first.auth.getStatus().signedIn).toBe(true);
    const second = await fixture(true, undefined, dir); await second.auth.init();
    expect(second.auth.getStatus()).toMatchObject({ signedIn: true, runtimeSlot: first.context.runtimeSlot });
    expect(second.store.clear).not.toHaveBeenCalled(); expect(second.fetchFn).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
