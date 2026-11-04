import { fetchMobileJourney, isConnectablePhase } from "../lib/journey";

describe("fetchMobileJourney", () => {
  const realFetch = global.fetch;
  function mockJourneyFetch(journeyResponse: Response): jest.Mock {
    const mock = jest.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "none" }), { status: 200 }))
      .mockResolvedValueOnce(journeyResponse);
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }
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
    const fetchMock = mockJourneyFetch(new Response(JSON.stringify({
      phase: "provisioning", detail: "d", nextAction: { kind: "wait" },
    }), { status: 200 }));
    const res = await fetchMobileJourney("https://app.matrix-os.com", "tok");
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.journey.phase).toBe("provisioning");
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      "https://app.matrix-os.com/billing/checkout/reconcile",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ runtimeSlot: "primary" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      "https://app.matrix-os.com/api/journey",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer tok" }) }),
    );
  });

  it("maps 401/403 to unauthorized (re-sign-in, not a dead retry)", async () => {
    global.fetch = (async () => new Response("", { status: 401 })) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unauthorized");
  });

  it("maps a 5xx / network failure to unreachable", async () => {
    global.fetch = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unreachable");
    global.fetch = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unreachable");
  });

  it("does not read a stale journey when checkout reconciliation fails", async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response("", { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect((await fetchMobileJourney("https://app.matrix-os.com", "tok")).status).toBe("unreachable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
