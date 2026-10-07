import { createNativeEditionRuntime } from "../lib/edition/native-runtime";
import { createNativeEditionDownloads } from "../lib/edition/native-downloads";
const computer = {
  handle: "reader",
  runtimeSlot: "slot-1",
  gatewayPath: "/vm/reader/gateway",
};
const raw = JSON.stringify({ messages: [], sources: [], pending: [] });
function storage() {
  const entries: Record<string, string> = {};
  return {
    entries,
    getItem: jest.fn(async (k: string) => entries[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => {
      entries[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete entries[k];
    }),
  };
}
afterEach(() => jest.restoreAllMocks());
it("calls the installed Edition API with a fresh authenticated token and no launch credentials", async () => {
  const getToken = jest
    .fn()
    .mockResolvedValueOnce("fresh-1")
    .mockResolvedValueOnce("fresh-2");
  const fetcher = jest.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ sources: [] }),
      }) as Response,
  );
  const runtime = createNativeEditionRuntime({
    ownerId: "owner",
    computer,
    getToken,
    isCurrent: () => true,
    storage: storage(),
    fetcher,
  });
  await runtime.bridge!("sources", {});
  await runtime.bridge!("sources", {});
  expect(fetcher.mock.calls[0][0]).toBe(
    "https://app.matrix-os.com/vm/reader/gateway/api/mail/action",
  );
  expect(fetcher.mock.calls[0][1]).toEqual(
    expect.objectContaining({
      body: JSON.stringify({
        appId: "edition",
        action: "sources",
        payload: {},
      }),
      headers: expect.objectContaining({ Authorization: "Bearer fresh-1" }),
      signal: expect.anything(),
    }),
  );
  expect(
    (fetcher.mock.calls[1][1]?.headers as Record<string, string>).Authorization,
  ).toBe("Bearer fresh-2");
});
it("allows explicit cold device downloads only for the current authenticated owner and computer", async () => {
  const disk = storage();
  let current = true;
  const first = createNativeEditionDownloads({
    ownerId: "owner",
    computer,
    storage: disk,
    isCurrent: () => current,
  });
  await first.load();
  await first.save(raw);
  const cold = createNativeEditionDownloads({
    ownerId: "owner",
    computer,
    storage: disk,
    isCurrent: () => current,
  });
  expect((await cold.load()).raw).toBe(raw);
  const second = createNativeEditionDownloads({
    ownerId: "other",
    computer,
    storage: disk,
    isCurrent: () => true,
  });
  expect((await second.load()).raw).toBeNull();
  expect(Object.values(disk.entries)).not.toContain(raw);
  current = false;
  await expect(first.save(raw)).rejects.toThrow("Reading session changed");
  expect(JSON.stringify(disk.entries)).not.toContain("Bearer");
});
it("uses cached reading only for network failures and refuses auth failures and malformed actions", async () => {
  const options = {
    ownerId: "owner",
    computer,
    getToken: async () => "token",
    isCurrent: () => true,
    storage: storage(),
  };
  const network = createNativeEditionRuntime({
    ...options,
    fetcher: jest.fn(async () => {
      throw new TypeError("Network request failed");
    }),
  });
  await expect(network.bridge!("sources", {})).rejects.toThrow(
    "Edition unavailable",
  );
  expect(network.online()).toBe(false);
  const forbidden = createNativeEditionRuntime({
    ...options,
    fetcher: jest.fn(async () => ({ ok: false, status: 403 }) as Response),
  });
  await expect(forbidden.bridge!("sources", {})).rejects.toThrow(
    "Edition unavailable",
  );
  expect(forbidden.online()).toBe(true);
  await expect(
    forbidden.bridge!("cleanup-commit", { planId: "bad path" }),
  ).rejects.toThrow();
});
it("rejects oversized or malformed device data before persistence", async () => {
  const disk = storage();
  const host = createNativeEditionDownloads({
    ownerId: "owner",
    computer,
    storage: disk,
    isCurrent: () => true,
  });
  await expect(
    host.save(
      JSON.stringify({
        messages: [],
        sources: [],
        pending: [],
        token: "secret",
      }),
    ),
  ).rejects.toThrow();
  expect(disk.setItem).not.toHaveBeenCalled();
});

it("clears authorized device copies when the server rejects the installed Edition identity", async () => {
  const disk = storage();
  const fetcher = jest.fn(async () => ({ ok: false, status: 403 }) as Response);
  const runtime = createNativeEditionRuntime({
    ownerId: "owner",
    computer,
    getToken: async () => "token",
    isCurrent: () => true,
    storage: disk,
    fetcher,
  });
  await runtime.downloads!.load();
  await runtime.downloads!.save(raw);
  const reset = jest.fn();
  const stop = runtime.subscribe!(jest.fn(), jest.fn(), reset);
  await expect(runtime.bridge!("sources", {})).rejects.toThrow(
    "Edition unavailable",
  );
  expect((await runtime.downloads!.load()).raw).toBeNull();
  expect(reset).toHaveBeenCalledTimes(1);
  stop();
});

it("persists native device reading without a browser TextEncoder global", async () => {
  const original = globalThis.TextEncoder;
  try {
    (globalThis as unknown as { TextEncoder: unknown }).TextEncoder = undefined;
    const disk = storage();
    const downloads = createNativeEditionDownloads({
      ownerId: "owner",
      computer,
      storage: disk,
      isCurrent: () => true,
    });
    await downloads.load();
    await downloads.save(raw);
    expect((await downloads.load()).raw).toBe(raw);
  } finally {
    globalThis.TextEncoder = original;
  }
});
