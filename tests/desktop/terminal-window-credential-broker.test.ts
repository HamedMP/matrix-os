import { beforeEach, describe, expect, it, vi } from "vitest";
import { createComputerCredentialBroker } from "@desktop/main/terminal-window/credential-broker";

const HOUR = 3_600_000;

function setup(options: { slots?: string[]; selected?: string } = {}) {
  let now = 1_000_000;
  let generation = 1;
  let signedIn = true;
  let counter = 0;
  const slots = options.slots ?? ["primary", "review", "extra"];
  const auth = {
    getStatus: vi.fn(() => signedIn
      ? { signedIn: true as const, authGeneration: generation, runtimeSlot: options.selected ?? "primary" }
      : { signedIn: false as const, authGeneration: generation, runtimeSlot: "primary" }),
    getToken: vi.fn(() => (signedIn ? "selected-token" : null)),
    issueRuntimeToken: vi.fn(async (slot: string) => ({ accessToken: `token-${slot}-${++counter}`, expiresAt: now + HOUR, handle: slot })),
    listRuntimeComputers: vi.fn(async () => ({ items: slots.map((runtimeSlot) => ({ runtimeSlot, availability: "available" })) })),
  };
  const broker = createComputerCredentialBroker({ auth, now: () => now, random: () => 0.5 });
  return {
    auth, broker,
    advance: (ms: number) => { now += ms; },
    replaceSession: () => { generation += 1; },
    signOut: () => { signedIn = false; generation += 1; },
  };
}

describe("computer credential broker", () => {
  beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => undefined); });

  it("uses the selected computer's own credential without minting", async () => {
    const { auth, broker } = setup();
    await expect(broker.token("primary")).resolves.toBe("selected-token");
    expect(auth.issueRuntimeToken).not.toHaveBeenCalled();
  });

  it("mints once per computer, lazily, and shares concurrent requests", async () => {
    const { auth, broker } = setup();
    expect(auth.issueRuntimeToken).not.toHaveBeenCalled();
    const [first, second] = await Promise.all([broker.token("review"), broker.token("review")]);
    expect(first).toBe("token-review-1");
    expect(second).toBe("token-review-1");
    await expect(broker.token("review")).resolves.toBe("token-review-1");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(1);
    expect(auth.listRuntimeComputers).toHaveBeenCalledTimes(1);
  });

  it("fails closed for a computer outside the inventory and for malformed slots", async () => {
    const { auth, broker } = setup();
    await expect(broker.token("someone-else")).resolves.toBeNull();
    await expect(broker.token("")).resolves.toBeNull();
    expect(auth.issueRuntimeToken).not.toHaveBeenCalled();
  });

  it("fails closed when the inventory cannot be read", async () => {
    const { auth, broker } = setup();
    auth.listRuntimeComputers.mockRejectedValueOnce(new Error("offline"));
    await expect(broker.token("review")).resolves.toBeNull();
    expect(auth.issueRuntimeToken).not.toHaveBeenCalled();
  });

  it("keeps using a token until it really expires when no replacement can be had", async () => {
    // Near the end of the parent session the platform stops issuing
    // replacements; the token in hand is still good for its last minute.
    const { auth, broker, advance } = setup();
    const first = await broker.token("review");
    advance(HOUR - 30_000);
    auth.issueRuntimeToken.mockRejectedValue(new Error("parent session too close to expiry"));
    await expect(broker.credential("review")).resolves.toEqual({ token: first });
    await expect(broker.credential("review")).resolves.toEqual({ token: first });
    advance(31_000);
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "unavailable" });
  });

  it("stays inside the owner's shared request budget across computers", async () => {
    const slots = Array.from({ length: 19 }, (_, index) => `slot-${index}`);
    const { auth, broker, advance } = setup({ slots: ["primary", ...slots] });
    const results = await Promise.all(slots.map((slot) => broker.credential(slot)));
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(12);
    expect(results.filter((result) => result.token === null)).toHaveLength(7);
    expect(results.filter((result) => result.token === null).every((result) => "reason" in result && result.reason === "unavailable")).toBe(true);
    // A minute later the rest can be fetched.
    advance(61_000);
    await Promise.all(slots.map((slot) => broker.credential(slot)));
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(19);
  });

  it("pauses every computer's requests for as long as the platform's rate limit asks", async () => {
    const { auth, broker, advance } = setup();
    auth.issueRuntimeToken.mockRejectedValueOnce(Object.assign(new Error("limited"), { retryAfterMs: 20_000 }));
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "unavailable" });
    // Another computer does not spend a request while the account is limited.
    await expect(broker.credential("extra")).resolves.toEqual({ token: null, reason: "unavailable" });
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(1);
    advance(20_001);
    await expect(broker.credential("extra")).resolves.toEqual({ token: "token-extra-1" });
  });

  it("re-mints shortly before expiry", async () => {
    const { auth, broker, advance } = setup();
    await broker.token("review");
    advance(HOUR - 30_000);
    await expect(broker.token("review")).resolves.toBe("token-review-2");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(2);
  });

  it("drops every token when the session is replaced and never stores a mint from the old session", async () => {
    const { auth, broker, replaceSession } = setup();
    let release!: (value: { accessToken: string; expiresAt: number; handle: string }) => void;
    auth.issueRuntimeToken.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const pending = broker.token("review");
    await vi.waitFor(() => expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(1));
    replaceSession();
    release({ accessToken: "old-session-token", expiresAt: 9e15, handle: "review" });
    await expect(pending).resolves.toBeNull();
    await expect(broker.token("review")).resolves.toBe("token-review-1");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(2);
  });

  it("returns nothing after sign-out", async () => {
    const { broker, signOut } = setup();
    await broker.token("review");
    signOut();
    await expect(broker.token("review")).resolves.toBeNull();
    await expect(broker.token("primary")).resolves.toBeNull();
  });

  it("backs off after a failed mint instead of retrying on every request", async () => {
    const { auth, broker, advance } = setup();
    auth.issueRuntimeToken.mockRejectedValue(new Error("rejected"));
    await expect(broker.token("review")).resolves.toBeNull();
    await expect(broker.token("review")).resolves.toBeNull();
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(1);
    advance(800);
    await broker.token("review");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(2);
    advance(800);
    await broker.token("review");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(2);
    advance(60_000);
    await broker.token("review");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(3);
    // Other computers are unaffected by one computer's failures.
    auth.issueRuntimeToken.mockResolvedValueOnce({ accessToken: "extra-ok", expiresAt: 9e15, handle: "extra" });
    await expect(broker.token("extra")).resolves.toBe("extra-ok");
  });

  it("re-mints once after a 401, then backs off if the new token is refused too", async () => {
    const { auth, broker } = setup();
    const first = await broker.token("review");
    broker.unauthorized("review", first!);
    await expect(broker.token("review")).resolves.toBe("token-review-2");
    broker.unauthorized("review", "token-review-2");
    await expect(broker.token("review")).resolves.toBeNull();
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(2);
  });

  it("ignores a 401 for a token it no longer holds and clears the strike on success", async () => {
    const { auth, broker } = setup();
    const first = await broker.token("review");
    broker.unauthorized("review", "some-older-token");
    await expect(broker.token("review")).resolves.toBe(first);
    broker.unauthorized("review", first!);
    const second = await broker.token("review");
    broker.confirmed("review");
    broker.unauthorized("review", second!);
    await expect(broker.token("review")).resolves.toBe("token-review-3");
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(3);
  });

  it("reaches only the first 20 computers of an oversized inventory", async () => {
    const slots = Array.from({ length: 25 }, (_, index) => `slot-${index}`);
    const { auth, broker, advance } = setup({ slots: ["primary", ...slots] });
    for (const slot of slots) await broker.token(slot);
    // The shared request budget spreads the mints over two minutes.
    advance(61_000);
    for (const slot of slots) await broker.token(slot);
    // "primary" uses the app's own bearer, so 19 of the first 20 are minted.
    expect(broker.size()).toBe(19);
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(19);
    await expect(broker.credential("slot-24")).resolves.toEqual({ token: null, reason: "denied" });
  });

  it("says whether a missing bearer means no access or try again", async () => {
    const { auth, broker, signOut } = setup();
    await expect(broker.credential("not-mine")).resolves.toEqual({ token: null, reason: "denied" });
    await expect(broker.credential("../x")).resolves.toEqual({ token: null, reason: "denied" });
    auth.issueRuntimeToken.mockRejectedValueOnce(new Error("platform down"));
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "unavailable" });
    // Still backing off: unavailable, without another mint.
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "unavailable" });
    expect(auth.issueRuntimeToken).toHaveBeenCalledTimes(1);
    signOut();
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "denied" });
  });

  it("reports an unreachable inventory as try again, not as no access", async () => {
    const { auth, broker } = setup();
    auth.listRuntimeComputers.mockRejectedValueOnce(new Error("offline"));
    await expect(broker.credential("review")).resolves.toEqual({ token: null, reason: "unavailable" });
  });

  it("never sends the newly selected computer's bearer for the previously selected one", async () => {
    // The app switches computer while the inventory is loading: its own
    // bearer now belongs to "review", so a request for "primary" must mint.
    let selected = "primary";
    let generation = 1;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const auth = {
      getStatus: vi.fn(() => ({ signedIn: true, authGeneration: generation, runtimeSlot: selected })),
      getToken: vi.fn(() => `own-token-for-${selected}`),
      issueRuntimeToken: vi.fn(async (slot: string) => ({ accessToken: `minted-${slot}`, expiresAt: Date.now() + HOUR, handle: slot })),
      listRuntimeComputers: vi.fn(async () => { await gate; return { items: [{ runtimeSlot: "primary" }, { runtimeSlot: "review" }] }; }),
    };
    const broker = createComputerCredentialBroker({ auth });
    const pending = broker.credential("primary");
    selected = "review";
    generation = 2;
    release();
    const found = await pending;
    expect(found.token).not.toBe("own-token-for-review");
    await expect(broker.credential("primary")).resolves.toEqual({ token: "minted-primary" });
    await expect(broker.credential("review")).resolves.toEqual({ token: "own-token-for-review" });
  });

  it("refreshes a stale inventory so a newly added computer becomes reachable", async () => {
    const { auth, broker, advance } = setup({ slots: ["primary"] });
    await expect(broker.token("review")).resolves.toBeNull();
    auth.listRuntimeComputers.mockResolvedValue({ items: [{ runtimeSlot: "primary", availability: "available" }, { runtimeSlot: "review", availability: "available" }] });
    advance(61_000);
    await expect(broker.token("review")).resolves.toBe("token-review-1");
  });
});
