import { FREE_PLAN_COPY } from "@matrix-os/contracts/free-plan-copy";
import { PROVISION_START_MESSAGES, fetchMobileJourney, isConnectablePhase, requestMobileProvisionStart } from "../lib/journey";

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
    global.fetch = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
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

describe("requestMobileProvisionStart", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  function answer(status: number, body: unknown) {
    const spy = jest.fn(async () => new Response(JSON.stringify(body), { status }));
    global.fetch = spy as unknown as typeof fetch;
    return spy;
  }

  it("asks the platform to start the build with the session token", async () => {
    const spy = answer(200, { status: "started" });
    expect(await requestMobileProvisionStart("https://app.matrix-os.com/", "tok")).toBeNull();
    expect(spy).toHaveBeenCalledWith("https://app.matrix-os.com/api/journey/retry-provision", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      body: "{}",
    }));
  });

  it("explains a full or unavailable build service without the server's text", async () => {
    answer(503, { error: "Free capacity is full at host-a 10.0.0.7" });
    const message = await requestMobileProvisionStart("https://app.matrix-os.com", "tok");
    expect(message).toBe(PROVISION_START_MESSAGES.unavailable);
    expect(message).not.toMatch(/host-a|10\.0|capacity is full/);
  });

  it("says the Free plan is at capacity when the platform reports it full (ENG-520)", async () => {
    answer(503, { error: "busy" });
    expect(await requestMobileProvisionStart("https://app.matrix-os.com", "tok")).toBe(PROVISION_START_MESSAGES.capacityFull);
    expect(PROVISION_START_MESSAGES.capacityFull).toBe(FREE_PLAN_COPY.capacityFull);
  });

  it.each([
    [429, { error: "retry_throttled" }, PROVISION_START_MESSAGES.throttled],
    [409, { error: "support_required" }, PROVISION_START_MESSAGES.support],
    [409, { error: "retry_exhausted" }, PROVISION_START_MESSAGES.support],
    [409, { error: "account_deletion_pending" }, PROVISION_START_MESSAGES.deletionPending],
    [409, { error: "something new" }, PROVISION_START_MESSAGES.generic],
    [500, "not json", PROVISION_START_MESSAGES.generic],
  ])("maps HTTP %i %j to a fixed message", async (status, body, expected) => {
    answer(status, body);
    expect(await requestMobileProvisionStart("https://app.matrix-os.com", "tok")).toBe(expected);
  });

  it.each([401, 402, 403])("leaves HTTP %i to the journey reload (sign-in or plans)", async (status) => {
    answer(status, { error: "billing_required" });
    expect(await requestMobileProvisionStart("https://app.matrix-os.com", "tok")).toBeNull();
  });

  it("reports a network failure as unreachable and never calls without a token", async () => {
    global.fetch = (async () => { throw new TypeError("network"); }) as unknown as typeof fetch;
    expect(await requestMobileProvisionStart("https://app.matrix-os.com", "tok")).toBe(PROVISION_START_MESSAGES.unreachable);
    const spy = jest.fn();
    global.fetch = spy as unknown as typeof fetch;
    expect(await requestMobileProvisionStart("https://app.matrix-os.com", null)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
