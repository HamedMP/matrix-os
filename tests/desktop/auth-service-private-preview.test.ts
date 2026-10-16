import { describe, expect, it, vi } from "vitest";
import { AuthService, type ConnectionProfile } from "@desktop/main/auth/auth-service";
import type { StoredCredential } from "@desktop/main/auth/credential-store";

const NOW = Date.parse("2026-10-16T07:00:00.000Z");
const SLOT = "pv-2545-1234abcd";
const credential: StoredCredential = { accessToken: "opaque-token", expiresAt: NOW + 3_600_000, userId: "owner", handle: "owner" };
const profile: ConnectionProfile = { handle: "owner", userId: "owner", platformHost: "https://app.matrix-os.com", runtimeSlot: "primary" };
const main = { handle: "owner", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/owner", capabilities: [] };
const inventory = { items: [main], selectedSlot: "primary", hasMore: false, limit: 20 };
const row = { machineId: "9c82cb12-b5e9-4d8a-9ab3-7e8ffe62ac01", handle: SLOT, pr: 2545, confirmedBundleVersion: "v2026.10.16-pr2545-123-1-abcdef0", status: "running", provisionedAt: "2026-10-15T07:00:00.000Z", expiresAt: "2026-10-18T07:00:00.000Z" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function service(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, slot = "primary", now = () => NOW) {
  const save = vi.fn(async () => undefined);
  const saveProfile = vi.fn(async () => undefined);
  const auth = new AuthService({
    credentialStore: { load: async () => credential, save, clear: vi.fn(async () => undefined) },
    platformHost: "https://app.matrix-os.com", runtimeSelectionOrigin: "https://api.matrix-os.com",
    loadProfile: async () => ({ ...profile, runtimeSlot: slot }), saveProfile, clearProfile: async () => undefined,
    onAuthChanged: vi.fn(), now, fetchFn,
  });
  return { auth, save, saveProfile };
}
function transport(privateResult: () => Promise<Response>, canonical: unknown = inventory) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    void init;
    if (url.endsWith("/api/auth/computers")) return json(canonical);
    if (url.endsWith("/api/private-previews")) return privateResult();
    return json({ accessToken: "r".repeat(64), expiresAt: NOW + 3_600_000, handle: SLOT, slot: SLOT });
  });
}

describe("normal owner-private computer discovery", () => {
  it("supplements the canonical list with a safe owner-private projection and uses normal selection", async () => {
    const fetchFn = transport(async () => json({ privatePreviews: [row] }));
    const { auth, save } = service(fetchFn); await auth.init();
    const result = await auth.listRuntimeComputers();
    expect(result.items).toContainEqual({ handle: SLOT, runtimeSlot: SLOT, label: "Preview Computer", availability: "available", kind: "preview", gatewayPath: `/vm/${SLOT}?runtime=${SLOT}`, capabilities: [] });
    expect(JSON.stringify(result)).not.toMatch(/machineId|opaque-token|provisionedAt|expiresAt/);
    await auth.selectRuntime(SLOT);
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://app.matrix-os.com/api/auth/computers", "https://app.matrix-os.com/api/private-previews",
      "https://app.matrix-os.com/api/private-previews", "https://api.matrix-os.com/api/auth/runtime-selection",
    ]);
    expect(fetchFn.mock.calls[1]?.[1]).toMatchObject({ method: "GET", redirect: "error", headers: { authorization: "Bearer opaque-token" }, signal: expect.any(AbortSignal) });
    expect(fetchFn.mock.calls[3]?.[1]?.body).toBe(JSON.stringify({ slot: SLOT }));
    expect(save).toHaveBeenCalledOnce();
    expect(auth.getStatus()).toMatchObject({ handle: SLOT, runtimeSlot: SLOT });
  });

  it.each([403, 503])("preserves public computers after private HTTP %s without caching stale private rows", async (status) => {
    let available = true;
    const { auth } = service(transport(async () => available ? json({ privatePreviews: [row] }) : json({}, status)));
    await auth.init();
    expect((await auth.listRuntimeComputers()).items).toHaveLength(2);
    available = false;
    expect(await auth.listRuntimeComputers()).toEqual(inventory);
  });

  it.each([
    { ...row, status: "stopped" }, { ...row, expiresAt: "2026-10-16T07:00:00.000Z" },
    { ...row, pr: 2546 }, { ...row, handle: "other" }, { ...row, machineId: "not-a-uuid" },
    { ...row, expiresAt: "invalid" }, { ...row, provisionedAt: "2026-10-17T07:00:00.000Z" },
    { ...row, expiresAt: "2027-10-18T07:00:00.000Z" }, { ...row, accessToken: "untrusted-extra" },
  ])("does not project invalid, stopped or expired private rows: %j", async (invalid) => {
    const { auth } = service(transport(async () => json({ privatePreviews: [invalid] }))); await auth.init();
    expect(await auth.listRuntimeComputers()).toEqual(inventory);
  });

  it.each([null, { privatePreviews: Array.from({ length: 51 }, () => row) }, { privatePreviews: [], extra: "secret" }])("contains malformed private envelopes: %j", async (body) => {
    const { auth } = service(transport(async () => json(body))); await auth.init();
    expect(await auth.listRuntimeComputers()).toEqual(inventory);
  });

  it("preserves public inventory on private transport failure", async () => {
    const { auth } = service(transport(async () => { throw new DOMException("timeout", "TimeoutError"); })); await auth.init();
    expect(await auth.listRuntimeComputers()).toEqual(inventory);
  });

  it("bounds streamed private response bytes even without content-length", async () => {
    const { auth } = service(transport(async () => new Response(" ".repeat(65_537)))); await auth.init();
    expect(await auth.listRuntimeComputers()).toEqual(inventory);
  });

  it("deduplicates canonical private slots and retains the selected private at the list limit", async () => {
    const privateComputer = { ...main, handle: SLOT, runtimeSlot: SLOT, label: "Preview Computer", kind: "preview", gatewayPath: `/vm/${SLOT}?runtime=${SLOT}` };
    const publicItems = Array.from({ length: 20 }, (_, n) => ({ ...main, handle: `owner-${n}`, runtimeSlot: `slot-${n}`, gatewayPath: `/vm/owner-${n}?runtime=slot-${n}` }));
    const canonical = { ...inventory, items: publicItems, selectedSlot: null };
    const { auth } = service(transport(async () => json({ privatePreviews: [row] }), canonical), SLOT); await auth.init();
    const list = await auth.listRuntimeComputers();
    expect(list.items).toHaveLength(20); expect(list.selectedSlot).toBe(SLOT); expect(list.items).toContainEqual(privateComputer); expect(list.hasMore).toBe(true);
    const { auth: deduped } = service(transport(async () => json({ privatePreviews: [row] }), { ...inventory, items: [main, privateComputer] })); await deduped.init();
    expect((await deduped.listRuntimeComputers()).items).toHaveLength(2);
  });

  it("keeps canonical private capability/version/availability projection after fresh owner admission", async () => {
    const privateComputer = { ...main, handle: SLOT, runtimeSlot: SLOT, label: "Preview Computer", kind: "preview", availability: "unavailable", versionLabel: "dev", capabilities: ["chat"], gatewayPath: `/vm/${SLOT}?runtime=${SLOT}` };
    const { auth } = service(transport(async () => json({ privatePreviews: [row] }), { ...inventory, items: [main, privateComputer] })); await auth.init();
    expect((await auth.listRuntimeComputers()).items).toContainEqual(privateComputer);
  });

  it("preserves a canonical customer whose arbitrary slot resembles a private handle", async () => {
    const customer = { ...main, runtimeSlot: SLOT, gatewayPath: `/vm/owner?runtime=${SLOT}` };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/computers")) return json({ ...inventory, items: [customer], selectedSlot: SLOT });
      if (url.endsWith("/private-previews")) return json({}, 403);
      return json({ accessToken: "r".repeat(64), expiresAt: NOW + 3_600_000, handle: "owner", slot: SLOT });
    });
    const { auth } = service(fetchFn); await auth.init();
    expect((await auth.listRuntimeComputers()).items).toEqual([customer]);
    await auth.selectRuntime(SLOT); expect(auth.getStatus()).toMatchObject({ handle: "owner", runtimeSlot: SLOT });
    expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
      "https://app.matrix-os.com/api/auth/computers", "https://app.matrix-os.com/api/private-previews",
      "https://app.matrix-os.com/api/private-previews", "https://app.matrix-os.com/api/auth/computers", "https://api.matrix-os.com/api/auth/runtime-selection",
    ]);
  });

  it("removes even canonical private entries when membership cannot be revalidated", async () => {
    const privateComputer = { ...main, handle: SLOT, runtimeSlot: SLOT, label: "Preview Computer", kind: "preview", gatewayPath: `/vm/${SLOT}?runtime=${SLOT}` };
    const { auth } = service(transport(async () => json({}, 403), { ...inventory, items: [main, privateComputer], selectedSlot: SLOT }), SLOT); await auth.init();
    expect(await auth.listRuntimeComputers()).toEqual({ ...inventory, selectedSlot: null });
  });

  it("does not supplement a canonical 401 or publish late inventory after sign-out", async () => {
    const fetchFn = vi.fn(async () => json({}, 401));
    const { auth } = service(fetchFn); await auth.init();
    await expect(auth.listRuntimeComputers()).rejects.toThrow("Runtime computers unavailable");
    expect(fetchFn).toHaveBeenCalledOnce(); expect(auth.getStatus().signedIn).toBe(false);
    const pending = deferred<Response>(); const heldFetch = transport(() => pending.promise); const second = service(heldFetch); await second.auth.init();
    const listing = second.auth.listRuntimeComputers(); await vi.waitFor(() => expect(heldFetch).toHaveBeenCalledTimes(2));
    await second.auth.signOut(); pending.resolve(json({ privatePreviews: [row] }));
    await expect(listing).rejects.toThrow("Runtime computers unavailable");
  });

  it("rejects an older list response when a newer refresh completes", async () => {
    const pending = deferred<Response>(); let count = 0;
    const fetchFn = transport(async () => ++count === 1 ? pending.promise : json({ privatePreviews: [] }));
    const { auth } = service(fetchFn); await auth.init(); const old = auth.listRuntimeComputers();
    await vi.waitFor(() => expect(count).toBe(1));
    expect(await auth.listRuntimeComputers()).toEqual(inventory); pending.resolve(json({ privatePreviews: [row] }));
    await expect(old).rejects.toThrow("Runtime computers unavailable");
  });

  it("does not publish old private inventory after an ordinary credential-generation replacement", async () => {
    const pending = deferred<Response>();
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/computers")) return json(inventory);
      if (url.endsWith("/private-previews")) return pending.promise;
      return json({ accessToken: "r".repeat(64), expiresAt: NOW + 3_600_000, handle: "review-owner", slot: "review" });
    });
    const { auth } = service(fetchFn); await auth.init(); const listing = auth.listRuntimeComputers();
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2)); await auth.selectRuntime("review");
    pending.resolve(json({ privatePreviews: [row] }));
    await expect(listing).rejects.toThrow("Runtime computers unavailable");
    expect(auth.getStatus()).toMatchObject({ handle: "review-owner", runtimeSlot: "review", authGeneration: 1 });
  });

  it("expires a current private 401 without exposing the partial inventory", async () => {
    const { auth } = service(transport(async () => json({}, 401))); await auth.init();
    await expect(auth.listRuntimeComputers()).rejects.toThrow("Runtime computers unavailable"); expect(auth.getStatus().signedIn).toBe(false);
  });

  it.each(["membership", "lease", "absent"]) ("rechecks %s before private exchange and leaves persistence untouched on rejection", async (reason) => {
    let listed = false;
    const fetchFn = transport(async () => !listed ? json({ privatePreviews: [row] }) : reason === "membership" ? json({}, 403) : json({ privatePreviews: reason === "absent" ? [] : [{ ...row, expiresAt: "2026-10-16T07:00:00.000Z" }] }));
    const { auth, save, saveProfile } = service(fetchFn); await auth.init(); await auth.listRuntimeComputers(); listed = true;
    await expect(auth.selectRuntime(SLOT)).rejects.toThrow("Computer switch failed. Try again.");
    expect(fetchFn.mock.calls.some(([url]) => url.endsWith("/runtime-selection"))).toBe(false);
    expect(save).not.toHaveBeenCalled(); expect(saveProfile).not.toHaveBeenCalled(); expect(auth.getStatus().runtimeSlot).toBe("primary");
  });

  it("fences sign-out during private admission before sending an exchange", async () => {
    const pending = deferred<Response>(); const fetchFn = transport(() => pending.promise);
    const { auth, save } = service(fetchFn); await auth.init(); const selection = auth.selectRuntime(SLOT);
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled()); await auth.signOut(); pending.resolve(json({ privatePreviews: [row] }));
    await expect(selection).rejects.toThrow("Computer switch failed. Try again.");
    expect(fetchFn.mock.calls.some(([url]) => url.endsWith("/runtime-selection"))).toBe(false); expect(save).not.toHaveBeenCalled();
  });

  it("rejects a slot-matching but handle-mismatching private exchange before any persistence", async () => {
    const fetchFn = vi.fn(async (url: string) => url.endsWith("/private-previews") ? json({ privatePreviews: [row] }) : json({ accessToken: "r".repeat(64), expiresAt: NOW + 3_600_000, handle: "wrong-owner", slot: SLOT }));
    const { auth, save, saveProfile } = service(fetchFn); await auth.init();
    await expect(auth.selectRuntime(SLOT)).rejects.toThrow("Computer switch failed. Try again.");
    expect(save).not.toHaveBeenCalled(); expect(saveProfile).not.toHaveBeenCalled();
  });

  it("does not exchange a stale private intent after a failed refresh removed its row", async () => {
    let available = true;
    const fetchFn = transport(async () => available ? json({ privatePreviews: [row] }) : json({}, 503));
    const { auth, save } = service(fetchFn); await auth.init(); await auth.listRuntimeComputers();
    available = false; expect(await auth.listRuntimeComputers()).toEqual(inventory);
    await expect(auth.selectRuntime(SLOT)).rejects.toThrow("Computer switch failed. Try again.");
    expect(fetchFn.mock.calls.some(([url]) => url.endsWith("/runtime-selection"))).toBe(false); expect(save).not.toHaveBeenCalled();
  });

  it("rejects lease expiry during a slow exchange before persistence", async () => {
    let now = NOW; const pending = deferred<Response>();
    const shortLease = { ...row, provisionedAt: new Date(NOW + 20_000 - 72 * 3_600_000).toISOString(), expiresAt: new Date(NOW + 20_000).toISOString() };
    const fetchFn = vi.fn(async (url: string) => url.endsWith("/private-previews") ? json({ privatePreviews: [shortLease] }) : pending.promise);
    const { auth, save } = service(fetchFn, "primary", () => now); await auth.init();
    const selection = auth.selectRuntime(SLOT); await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
    now = Date.parse(shortLease.expiresAt); pending.resolve(json({ accessToken: "r".repeat(64), expiresAt: now + 3_600_000, handle: SLOT, slot: SLOT }));
    await expect(selection).rejects.toThrow("Computer switch failed. Try again."); expect(save).not.toHaveBeenCalled();
  });

  it("aborts private body reads on the same request timeout and preserves public inventory", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const fetchFn = transport(async () => new Response(new ReadableStream({ start() { /* held until cancellation */ } })));
    try {
      const { auth } = service(fetchFn); await auth.init(); const listing = auth.listRuntimeComputers();
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2)); controller.abort(new DOMException("timeout", "TimeoutError"));
      expect(await listing).toEqual(inventory);
    } finally { timeout.mockRestore(); }
  });

  it("does not restore an unavailable private runtime into Main during a new sign-in", async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/device/code")) return json({ deviceCode: "device", userCode: "ABCD", verificationUri: "https://app.matrix-os.com/device", expiresIn: 600, interval: 5 });
      if (url.endsWith("/device/token")) return json({ accessToken: "new-device-token", expiresAt: NOW + 3_600_000, userId: "owner", handle: "owner" });
      return json({}, 403);
    });
    const { auth, save } = service(fetchFn, SLOT); await auth.init(); await auth.startDeviceFlow("sign-in");
    await vi.waitFor(() => expect(auth.poll().status).toBe("expired"));
    expect(save).not.toHaveBeenCalled(); expect(auth.getStatus().runtimeSlot).toBe(SLOT);
  });

  it("retains primary restore recovery after fresh proof of a customer with a private-looking slot", async () => {
    const customer = { ...main, runtimeSlot: SLOT, gatewayPath: `/vm/owner?runtime=${SLOT}` };
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith("/device/code")) return json({ deviceCode: "device", userCode: "ABCD", verificationUri: "https://app.matrix-os.com/device", expiresIn: 600, interval: 5 });
      if (url.endsWith("/device/token")) return json({ accessToken: "new-device-token", expiresAt: NOW + 3_600_000, userId: "owner", handle: "owner" });
      if (url.endsWith("/auth/computers")) return json({ ...inventory, items: [customer], selectedSlot: SLOT });
      return json({}, 403);
    });
    const { auth, save } = service(fetchFn, SLOT); await auth.init(); await auth.startDeviceFlow("sign-in");
    await vi.waitFor(() => expect(auth.poll().status).toBe("authorized"));
    expect(save).toHaveBeenCalledOnce(); expect(auth.getStatus().runtimeSlot).toBe("primary");
  });

  it("rejects lease expiry during credential persistence before committing a private runtime", async () => {
    let now = NOW;
    const pending = deferred<void>();
    const shortLease = { ...row, provisionedAt: new Date(NOW + 20_000 - 72 * 3_600_000).toISOString(), expiresAt: new Date(NOW + 20_000).toISOString() };
    const { auth, save, saveProfile } = service(transport(async () => json({ privatePreviews: [shortLease] })), "primary", () => now);
    save.mockImplementationOnce(() => pending.promise);
    await auth.init(); const selection = auth.selectRuntime(SLOT);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    now = Date.parse(shortLease.expiresAt); pending.resolve();
    await expect(selection).rejects.toThrow("Computer switch failed. Try again.");
    expect(saveProfile).not.toHaveBeenCalled(); expect(auth.getStatus().runtimeSlot).toBe("primary");
    expect(save).toHaveBeenLastCalledWith(credential);
  });
});
