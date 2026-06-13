import { fetchMobileJourney, isConnectablePhase } from "../lib/journey";

describe("fetchMobileJourney", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns unauthorized when there is no token (never calls the network)", async () => {
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    const res = await fetchMobileJourney("https://app.matrix-os.com", null);
    expect(res).toEqual({ status: "unauthorized" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns ok with the journey on 200", async () => {
    global.fetch = (async () => new Response(JSON.stringify({ phase: "provisioning", detail: "d", nextAction: { kind: "wait" } }), { status: 200 })) as unknown as typeof fetch;
    const res = await fetchMobileJourney("https://app.matrix-os.com", "tok");
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.journey.phase).toBe("provisioning");
  });

  it("maps 401/403 to unauthorized (re-sign-in, not a dead retry)", async () => {
    global.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unauthorized");
  });

  it("maps a 5xx / network failure to unreachable", async () => {
    global.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unreachable");
    global.fetch = (async () => { throw new Error("network"); }) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unreachable");
  });
});

describe("isConnectablePhase", () => {
  it("is true only for first_run and ready", () => {
    expect(isConnectablePhase("ready")).toBe(true);
    expect(isConnectablePhase("first_run")).toBe(true);
    expect(isConnectablePhase("provisioning")).toBe(false);
    expect(isConnectablePhase("plan_required")).toBe(false);
  });
});
