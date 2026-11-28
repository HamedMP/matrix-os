import { afterEach, describe, expect, it, vi } from "vitest";
import { handleManagedTerminalCanary } from "../../packages/edge-router/src/terminal-canary-worker.js";

const ORIGIN = "https://matrix-platform.example.run.app";
const CANDIDATE = "https://tc-d6bc5cf---matrix-platform.example.run.app";
const SOURCE = "owner-main";
const CHAT = "chat_local_canary";
const BASE_PATH = `/vm/${SOURCE}/~runtime/primary/api/chats/${CHAT}`;
const NOW = 1_800_000_000_000;
const CONFIG = { sourceHandle: SOURCE, chatId: CHAT, candidateOrigin: CANDIDATE, expiresAt: NOW + 2000 };
const defaultFetch = vi.fn(async (_request: Request) => new Response("default"));
const ENV = {
  DEFAULT_EDGE_ROUTER: { fetch: defaultFetch },
  PLATFORM_ORIGIN: ORIGIN,
  EDGE_ROUTER_SECRET: "edge-secret",
  MATRIX_MANAGED_TERMINAL_EDGE_CANARY_V1: JSON.stringify(CONFIG),
};
const MARKER = "x-matrix-terminal-canary-route";

afterEach(() => { vi.restoreAllMocks(); defaultFetch.mockClear(); });

function request(path: string, init: RequestInit = {}, host = "app.matrix-os.com") {
  const method = init.method ?? "POST";
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Request(`https://${host}${path}`, {
    ...init, headers, method, ...(method === "GET" ? {} : { body: init.body ?? "{}" }),
  });
}

function installClockAndOrigin(upstreamHeaders?: HeadersInit) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(NOW);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok", { headers: upstreamHeaders }));
  return { clock, fetchMock };
}

describe("owner terminal Cloud Run canary", () => {
  it.each([
    `${BASE_PATH}/turns?chatMessageVersion=2`,
    `${BASE_PATH}/runs/run_canary/cancel`,
    `/vm/${SOURCE}/api/chats/${CHAT}/turns?runtime=primary`,
  ])("forwards only exact primary Chat mutations to the tagged candidate: %s", async path => {
    const { fetchMock } = installClockAndOrigin();
    const body = "{\"clientRequestId\":\"req_one\"}";
    const result = await handleManagedTerminalCanary(request(path, {
      body,
      headers: {
        authorization: "Bearer browser-test",
        cookie: "__session=session-test",
        origin: "https://app.matrix-os.com",
        "x-matrix-edge-secret": "forged",
        "x-forwarded-host": "evil.example",
      },
    }), ENV);

    const upstream = fetchMock.mock.calls[0]![0] as Request;
    expect(upstream.url).toBe(CANDIDATE + path);
    expect(upstream.method).toBe("POST");
    expect(upstream.headers.get("authorization")).toBe("Bearer browser-test");
    expect(upstream.headers.get("cookie")).toBe("__session=session-test");
    expect(upstream.headers.get("origin")).toBe("https://app.matrix-os.com");
    expect(upstream.headers.get("x-matrix-edge-secret")).toBe("edge-secret");
    expect(upstream.headers.get("x-forwarded-host")).toBe("app.matrix-os.com");
    expect(await upstream.text()).toBe(body);
    expect(result.headers.get(MARKER)).toBe("candidate");
  });

  it.each([
    [BASE_PATH + "/turns", "GET", "app.matrix-os.com"],
    [BASE_PATH + "/turns", "POST", "api.matrix-os.com"],
    [BASE_PATH + "/turns", "POST", "code.matrix-os.com"],
    [BASE_PATH + "/turns?runtime=dev", "POST", "app.matrix-os.com"],
    [BASE_PATH + "/turns?runtime=primary&runtime=primary", "POST", "app.matrix-os.com"],
    [BASE_PATH + "/turns?token=untrusted", "POST", "app.matrix-os.com"],
    [BASE_PATH + "/queued-turns", "POST", "app.matrix-os.com"],
    [BASE_PATH + "/runs/not-a-run/cancel", "POST", "app.matrix-os.com"],
    [BASE_PATH + "/runs/run_canary/approvals/approval_id", "POST", "app.matrix-os.com"],
    [BASE_PATH.replace(CHAT, CHAT + "_other") + "/turns", "POST", "app.matrix-os.com"],
    [BASE_PATH.replace(SOURCE, SOURCE + "-dev") + "/turns", "POST", "app.matrix-os.com"],
    [BASE_PATH.replace("~runtime/primary", "~runtime/dev") + "/turns", "POST", "app.matrix-os.com"],
    [`/vm/${SOURCE}/api/chats/${CHAT}/turns`, "POST", "app.matrix-os.com"],
    [`/api/chats/${CHAT}/turns?runtime=primary`, "POST", "app.matrix-os.com"],
  ])("keeps unmatched %s %s %s on default", async (path, method, host) => {
    const { fetchMock } = installClockAndOrigin();
    const original = request(path, { method }, host);
    const response = await handleManagedTerminalCanary(original, ENV);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(defaultFetch).toHaveBeenCalledExactlyOnceWith(original);
    expect(response.headers.get(MARKER)).toBeNull();
  });

  it.each([
    undefined, "{", "null", "[]",
    JSON.stringify({ ...CONFIG, extra: true }),
    JSON.stringify({ ...CONFIG, expiresAt: NOW }),
    JSON.stringify({ ...CONFIG, expiresAt: NOW + 2 * 60 * 60 * 1000 + 1 }),
    JSON.stringify({ ...CONFIG, expiresAt: String(NOW + 1000) }),
    JSON.stringify({ ...CONFIG, candidateOrigin: "https://tc-d6bc5cf---other.example.run.app" }),
    JSON.stringify({ ...CONFIG, candidateOrigin: "https://pr3795-test---matrix-platform.example.run.app" }),
    JSON.stringify({ ...CONFIG, candidateOrigin: CANDIDATE + "/path" }),
    JSON.stringify({ ...CONFIG, candidateOrigin: CANDIDATE + "?query" }),
    JSON.stringify({ ...CONFIG, candidateOrigin: CANDIDATE.replace("https://", "https://user:pass@") }),
    JSON.stringify({ ...CONFIG, candidateOrigin: CANDIDATE.replace("https://", "http://") }),
  ])("keeps missing or malformed config on default: %s", async config => {
    const { fetchMock } = installClockAndOrigin();
    const path = BASE_PATH + "/turns";
    const original = request(path);
    const response = await handleManagedTerminalCanary(original, { ...ENV, MATRIX_MANAGED_TERMINAL_EDGE_CANARY_V1: config });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(defaultFetch).toHaveBeenCalledExactlyOnceWith(original);
    expect(response.headers.get(MARKER)).toBeNull();
  });

  it("does not retry a scoped mutation on the default Worker when the candidate transport fails", async () => {
    const { fetchMock } = installClockAndOrigin();
    fetchMock.mockRejectedValueOnce(new Error("unreachable"));
    const result = await handleManagedTerminalCanary(request(BASE_PATH + "/turns"), ENV);
    expect(result.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(defaultFetch).not.toHaveBeenCalled();
  });

  it("rechecks route expiry after a browser body arrives", async () => {
    const { clock, fetchMock } = installClockAndOrigin();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        started.resolve();
        await release.promise;
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    }, { highWaterMark: 0 });
    const path = BASE_PATH + "/turns";
    const init = { body: stream, duplex: "half" } satisfies RequestInit & { duplex: "half" };
    const original = request(path, init);
    const pending = handleManagedTerminalCanary(original, ENV);
    await started.promise;
    clock.mockReturnValue(CONFIG.expiresAt);
    release.resolve();

    expect((await pending).headers.get(MARKER)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(defaultFetch).toHaveBeenCalledTimes(1);
    const fallback = defaultFetch.mock.calls[0]![0];
    expect(fallback.url).toBe(original.url);
    expect(fallback.method).toBe(original.method);
    expect([...fallback.headers]).toEqual([...original.headers]);
    expect(await fallback.text()).toBe("{}");
  });

  it("rejects a chunked oversized turn without waiting for the client to finish uploading", async () => {
    const { fetchMock } = installClockAndOrigin();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024 + 1));
      },
    });
    const init = { body: stream, duplex: "half" } satisfies RequestInit & { duplex: "half" };
    const original = request(BASE_PATH + "/turns", init);
    const pending = handleManagedTerminalCanary(original, ENV);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1000); });
    try {
      expect(await Promise.race([pending, deadline])).toMatchObject({ status: 413 });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(defaultFetch).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      if (!original.bodyUsed) await original.body?.cancel();
      await pending;
    }
  });
});
