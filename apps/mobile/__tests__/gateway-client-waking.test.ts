import { GatewayClient, type RuntimeWakeEvent } from "../lib/gateway-client";

// The platform answers an owner request for a sleeping Matrix computer before
// proxying it: 503 + runtimeState + Retry-After (spec 2691, ENG-520).
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const make = (): Response => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: jest.fn().mockResolvedValue(body),
    text: jest.fn().mockResolvedValue(text),
    clone: jest.fn(() => make()),
  }) as unknown as Response;
  return make();
}

const waking = () => response(503, { error: "Matrix computer not ready", runtimeState: "waking" }, { "Retry-After": "3" });
const busy = () => response(503, { error: "Matrix computer not ready", runtimeState: "busy" }, { "Retry-After": "30" });
const unavailable = () => response(503, { error: "Matrix computer unavailable", code: "runtime_unavailable" });
const apps = () => response(200, [{ name: "Notes", path: "notes" }]);

describe("GatewayClient waits for a waking Matrix computer", () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Math, "random").mockReturnValue(0);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("retries a 503 with runtimeState waking after Retry-After, up to 30 s total", async () => {
    const calledAt: number[] = [];
    fetchMock.mockImplementation(async () => {
      calledAt.push(Date.now());
      return waking();
    });
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));
    const startedAt = Date.now();

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(11);
    expect(calledAt.at(-1)! - startedAt).toBeLessThanOrEqual(30_000);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_waking" });
  });

  it("returns the real response once the computer is awake", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(apps());
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toEqual([{ name: "Notes", path: "notes" }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).toBeDefined();
    }
  });

  it("does not retry a 503 runtime_unavailable more than once", async () => {
    fetchMock.mockImplementation(async () => unavailable());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_unavailable" });
  });

  it("retries a busy computer once after at most 10 s, then reports capacity", async () => {
    fetchMock.mockImplementation(async () => busy());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(9_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events.at(-1)).toEqual({ type: "failed", code: "runtime_busy" });
  });

  it("shows the waking state after 3 s", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(apps());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(2_999);
    expect(client.isWakeNoticeVisible).toBe(false);
    expect(events).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    expect(client.isWakeNoticeVisible).toBe(true);
    expect(events).toEqual([{ type: "notice", visible: true }]);

    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toHaveLength(1);
    expect(client.isWakeNoticeVisible).toBe(false);
    expect(events).toEqual([
      { type: "notice", visible: true },
      { type: "notice", visible: false },
    ]);
  });

  it("never shows the notice for a wake that finishes within 3 s", async () => {
    const quickWake = response(503, { runtimeState: "starting" }, { "Retry-After": "2" });
    fetchMock.mockResolvedValueOnce(quickWake).mockResolvedValueOnce(apps());
    const events: RuntimeWakeEvent[] = [];
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    client.onRuntimeWake((event) => events.push(event));

    const result = client.getApps();
    await jest.advanceTimersByTimeAsync(3_000);
    await expect(result).resolves.toHaveLength(1);
    await jest.advanceTimersByTimeAsync(10_000);

    expect(events).toEqual([]);
  });

  it("stops waiting when the caller aborts", async () => {
    fetchMock.mockImplementation(async () => waking());
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");
    const controller = new AbortController();

    const result = client.getGithubDeveloperSetup("4f8e2c1a-9b7d-4e3f-8a6b-2c1d0e9f8a7b", controller.signal)
      .catch((err: unknown) => err);
    await jest.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(await result).toBeInstanceOf(Error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(client.isWakeNoticeVisible).toBe(false);
  });

  it("waits for the computer before a terminal reconnect opens its websocket", async () => {
    fetchMock
      .mockResolvedValueOnce(waking())
      .mockResolvedValueOnce(response(200, { status: "ok" }));
    const client = new GatewayClient("https://app.matrix-os.com/vm/alice", "clerk-token");

    const ready = client.waitForRuntimeAwake();
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(ready).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.matrix-os.com/vm/alice/health");
  });
});
