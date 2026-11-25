import { describe, expect, it, vi } from "vitest";
import { APP_FILE_MAX_BYTES } from "../../packages/contracts/src/app-files";
import {
  OFFICE_FILE_TYPES,
  OPEN_REQUEST_ACK_KV_KEY,
  OPEN_REQUEST_KV_KEY,
  OPEN_REQUEST_MAX_LISTENERS,
  OPEN_REQUEST_TTL_MS,
  OpenRequestSchema,
  canOpenWithDefaultApp,
  createOpenRequest,
  createOpenRequestInbox,
  defaultAppForFile,
  officeMimeTypeForFile,
  openWithHandoff,
  parseOpenRequest,
  type OpenRequest,
} from "../../packages/contracts/src/office-open-with";

const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const NONCE = "5b0c6f0e-9a53-4c58-8d1f-0f6f1c2a7e11";

function request(overrides: Partial<OpenRequest> = {}): OpenRequest {
  return { path: "Documents/report.docx", requestedAt: new Date(NOW).toISOString(), nonce: NONCE, ...overrides };
}

/** Stand-in for the host key-value store: one value per key and change events after each write. */
function createHost(app = "docs") {
  const values = new Map<string, unknown>();
  const listeners = new Set<(key: string, changedApp: string) => void>();
  let now = NOW;
  const host = {
    app,
    now: () => now,
    readData: vi.fn(async (key: string) => values.get(key) ?? null),
    writeData: vi.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      for (const listener of [...listeners]) listener(key, app);
    }),
    onDataChange: vi.fn((listener: (key: string, changedApp: string) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    }),
  };
  return {
    host,
    values,
    listeners,
    advance(ms: number) { now += ms; },
    /** What Files does: store the request, which notifies the running app. */
    async handOff(value: unknown, changedApp = app) {
      values.set(OPEN_REQUEST_KV_KEY, value);
      for (const listener of [...listeners]) listener(OPEN_REQUEST_KV_KEY, changedApp);
      await settle();
    },
  };
}

async function settle() {
  for (let turn = 0; turn < 12; turn++) await Promise.resolve();
}

describe("default app for a file", () => {
  it.each([
    ["report.docx", "docs"],
    ["REPORT.DOCX", "docs"],
    ["Documents/Contracts/lease v2.docx", "docs"],
    ["budget.xlsx", "sheets"],
    ["export.csv", "sheets"],
    ["export.TSV", "sheets"],
    ["archive.tar.csv", "sheets"],
  ] as const)("opens %s with %s", (name, app) => {
    expect(defaultAppForFile(name)).toBe(app);
  });

  it.each([
    "notes.md", "report.doc", "budget.xls", "slides.pptx", "report.docx.bak", "docx", "report.", "", "Documents/",
    // A hidden file with no stem has no extension.
    ".docx", "Documents/.csv",
    // Owner lock files that sit beside an open document are not documents.
    "~$report.docx", "Documents/~$budget.xlsx",
    // The extension belongs to the file name, never to a parent directory.
    "archive.docx/readme",
  ])("has no default app for %j", (name) => {
    expect(defaultAppForFile(name)).toBeNull();
  });

  it("names the media type of every handled extension", () => {
    expect(Object.keys(OFFICE_FILE_TYPES).sort()).toEqual(["csv", "docx", "tsv", "xlsx"]);
    expect(officeMimeTypeForFile("a.docx")).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(officeMimeTypeForFile("a.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(officeMimeTypeForFile("a.csv")).toBe("text/csv");
    expect(officeMimeTypeForFile("a.tsv")).toBe("text/tab-separated-values");
    expect(officeMimeTypeForFile("a.md")).toBeNull();
  });
});

describe("open request", () => {
  it("uses keys that the key-value bridge keeps intact", () => {
    expect(OPEN_REQUEST_KV_KEY).toBe("open-request");
    expect(OPEN_REQUEST_ACK_KV_KEY).toBe("open-request-ack");
    expect(OPEN_REQUEST_KV_KEY.replace(/[^a-zA-Z0-9_-]/g, "")).toBe(OPEN_REQUEST_KV_KEY);
    expect(OPEN_REQUEST_ACK_KV_KEY.replace(/[^a-zA-Z0-9_-]/g, "")).toBe(OPEN_REQUEST_ACK_KV_KEY);
  });

  it("accepts a well-formed request and nothing else", () => {
    expect(OpenRequestSchema.safeParse(request()).success).toBe(true);
    expect(OpenRequestSchema.safeParse(request({ path: "../system/soul.md" })).success).toBe(false);
    expect(OpenRequestSchema.safeParse(request({ path: "/abs/report.docx" })).success).toBe(false);
    expect(OpenRequestSchema.safeParse(request({ requestedAt: "today" })).success).toBe(false);
    expect(OpenRequestSchema.safeParse(request({ nonce: "short" })).success).toBe(false);
    expect(OpenRequestSchema.safeParse(request({ nonce: "has spaces in the nonce" })).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ ...request(), mode: "edit" }).success).toBe(false);
    expect(OpenRequestSchema.safeParse({ path: "a.docx", nonce: NONCE }).success).toBe(false);
  });

  it("builds a request from a path, a time and a nonce", () => {
    expect(createOpenRequest("Documents/report.docx", { now: NOW, nonce: NONCE })).toEqual(request());
    expect(createOpenRequest("Documents/report.docx", { now: new Date(NOW), nonce: NONCE })).toEqual(request());
    expect(() => createOpenRequest("../report.docx", { now: NOW, nonce: NONCE })).toThrow();
    expect(() => createOpenRequest("report.docx", { now: NOW, nonce: "x" })).toThrow();
    expect(() => createOpenRequest("report.docx", { now: Number.NaN, nonce: NONCE })).toThrow();
  });

  it("plans a hand-off only for files that have a default app", () => {
    expect(openWithHandoff("Documents/report.docx", { now: NOW, nonce: NONCE })).toEqual({ app: "docs", key: "open-request", request: request() });
    expect(openWithHandoff("budget.xlsx", { now: NOW, nonce: NONCE })).toMatchObject({ app: "sheets", request: { path: "budget.xlsx" } });
    expect(openWithHandoff("notes.md", { now: NOW, nonce: NONCE })).toBeNull();
    expect(openWithHandoff("../secret.docx", { now: NOW, nonce: NONCE })).toBeNull();
  });

  it.each([
    "system/logs/usage.csv", "agents/notes/plan.docx", ".hermes/export.csv", ".cache/a.xlsx",
    "data/browser-profiles/p/export.csv", "data/app-gallery-staging/x/sheet.xlsx",
  ])("never hands %s to an app that the app file route refuses", (path) => {
    expect(openWithHandoff(path, { now: NOW, nonce: NONCE })).toBeNull();
    expect(canOpenWithDefaultApp(path)).toBe(false);
    expect(canOpenWithDefaultApp(path, 3)).toBe(false);
  });

  it("routes a file to its default app only when the app can read it", () => {
    expect(canOpenWithDefaultApp("Documents/report.docx")).toBe(true);
    expect(canOpenWithDefaultApp("Documents/big.csv", null)).toBe(true);
    expect(canOpenWithDefaultApp("Documents/big.csv", APP_FILE_MAX_BYTES)).toBe(true);
    expect(canOpenWithDefaultApp("Documents/big.csv", APP_FILE_MAX_BYTES + 1)).toBe(false);
    expect(canOpenWithDefaultApp("Documents/notes.txt", 3)).toBe(false);
    expect(canOpenWithDefaultApp("../escape.docx")).toBe(false);
    // A folder or file that only resembles a protected one stays openable.
    expect(canOpenWithDefaultApp("systems/report.docx")).toBe(true);
    expect(canOpenWithDefaultApp("Documents/system/report.docx")).toBe(true);
    expect(canOpenWithDefaultApp("data/browser-profiles-old/export.csv")).toBe(true);
  });

  it("reads back only a fresh, well-formed request", () => {
    expect(parseOpenRequest(request(), NOW)).toEqual(request());
    expect(parseOpenRequest(request(), NOW + OPEN_REQUEST_TTL_MS)).toEqual(request());
    expect(parseOpenRequest(request(), NOW + OPEN_REQUEST_TTL_MS + 1)).toBeNull();
    // A request stamped far in the future is not trusted to stay pending forever.
    expect(parseOpenRequest(request({ requestedAt: new Date(NOW + 30_000).toISOString() }), NOW)).toEqual(expect.objectContaining({ nonce: NONCE }));
    expect(parseOpenRequest(request({ requestedAt: new Date(NOW + 5 * 60_000).toISOString() }), NOW)).toBeNull();
    for (const value of [null, undefined, "", "Documents/report.docx", 7, [], {}, { ...request(), extra: true }]) {
      expect(parseOpenRequest(value, NOW)).toBeNull();
    }
  });
});

describe("open request inbox", () => {
  it("delivers a pending request once on load and records it as handled", async () => {
    const { host, values } = createHost();
    values.set(OPEN_REQUEST_KV_KEY, request());
    const inbox = createOpenRequestInbox(host);
    expect(await inbox.openRequest()).toEqual(request());
    await settle();
    expect(host.writeData).toHaveBeenCalledWith(OPEN_REQUEST_ACK_KV_KEY, NONCE);
    expect(await inbox.openRequest()).toBeNull();
    // A reload starts a new inbox: the handled request is not opened again.
    expect(await createOpenRequestInbox(host).openRequest()).toBeNull();
  });

  it("never writes the request key, so a request Files stores during a read is not lost", async () => {
    const { host, values } = createHost();
    const second = request({ path: "Documents/second.docx", nonce: "second-nonce-0001" });
    values.set(OPEN_REQUEST_KV_KEY, request());
    // Files stores the next request right after the store served the first one.
    host.readData.mockImplementationOnce(async (key: string) => {
      const value = values.get(key) ?? null;
      values.set(OPEN_REQUEST_KV_KEY, second);
      return value;
    });
    const inbox = createOpenRequestInbox(host);
    expect(await inbox.openRequest()).toEqual(request());
    await settle();
    expect(host.writeData.mock.calls.map(([key]) => key)).not.toContain(OPEN_REQUEST_KV_KEY);
    expect(await inbox.openRequest()).toEqual(second);
  });

  it("resolves null when nothing is pending", async () => {
    const { host } = createHost();
    const inbox = createOpenRequestInbox(host);
    expect(await inbox.openRequest()).toBeNull();
    expect(host.writeData).not.toHaveBeenCalled();
  });

  it("never delivers the same nonce twice, even when the acknowledgement fails", async () => {
    const { host, values } = createHost();
    host.writeData.mockRejectedValue(new Error("store offline"));
    values.set(OPEN_REQUEST_KV_KEY, request());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const inbox = createOpenRequestInbox(host);
    const [first, second] = await Promise.all([inbox.openRequest(), inbox.openRequest()]);
    expect([first, second].filter(Boolean)).toEqual([request()]);
    expect(await inbox.openRequest()).toBeNull();
    await settle();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("still delivers when the acknowledgement cannot be read", async () => {
    const { host, values } = createHost();
    values.set(OPEN_REQUEST_KV_KEY, request());
    host.readData.mockImplementation(async (key: string) => {
      if (key === OPEN_REQUEST_ACK_KV_KEY) throw new Error("token=secret");
      return values.get(key) ?? null;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await createOpenRequestInbox(host).openRequest()).toEqual(request());
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  it("drops stale and malformed requests without opening or acknowledging them", async () => {
    const stale = createHost();
    stale.values.set(OPEN_REQUEST_KV_KEY, request());
    stale.advance(OPEN_REQUEST_TTL_MS + 1);
    expect(await createOpenRequestInbox(stale.host).openRequest()).toBeNull();
    await settle();
    expect(stale.host.writeData).not.toHaveBeenCalled();

    const malformed = createHost();
    malformed.values.set(OPEN_REQUEST_KV_KEY, { path: "../system/soul.md", requestedAt: "now", nonce: NONCE });
    expect(await createOpenRequestInbox(malformed.host).openRequest()).toBeNull();
    await settle();
    expect(malformed.host.writeData).not.toHaveBeenCalled();
  });

  it("resolves null when the store cannot be read", async () => {
    const { host } = createHost();
    host.readData.mockRejectedValue(new Error("token=secret"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await createOpenRequestInbox(host).openRequest()).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  it("notifies a running app of each new request", async () => {
    const env = createHost();
    const inbox = createOpenRequestInbox(env.host);
    const received: OpenRequest[] = [];
    const off = inbox.onOpenRequest((next) => received.push(next));
    await env.handOff(request());
    const second = request({ path: "Documents/second.docx", nonce: "second-nonce-0001" });
    await env.handOff(second);
    expect(received).toEqual([request(), second]);
    // Each acknowledgement raises a change event of its own; it must not loop or re-deliver.
    expect(env.host.writeData.mock.calls).toEqual([[OPEN_REQUEST_ACK_KV_KEY, NONCE], [OPEN_REQUEST_ACK_KV_KEY, "second-nonce-0001"]]);
    off();
    await env.handOff(request({ nonce: "third-nonce-00001" }));
    expect(received).toHaveLength(2);
    expect(env.listeners.size).toBe(0);
  });

  it("ignores changes to other keys and other apps", async () => {
    const env = createHost("docs");
    const inbox = createOpenRequestInbox(env.host);
    const callback = vi.fn();
    inbox.onOpenRequest(callback);
    env.values.set(OPEN_REQUEST_KV_KEY, request());
    for (const listener of [...env.listeners]) listener("drafts", "docs");
    for (const listener of [...env.listeners]) listener(OPEN_REQUEST_KV_KEY, "sheets");
    await settle();
    expect(callback).not.toHaveBeenCalled();
    expect(env.host.readData).not.toHaveBeenCalled();
  });

  it("delivers one request to every listener through a single store subscription", async () => {
    const env = createHost();
    const inbox = createOpenRequestInbox(env.host);
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = inbox.onOpenRequest(first);
    const offSecond = inbox.onOpenRequest(second);
    expect(env.host.onDataChange).toHaveBeenCalledTimes(1);
    await env.handOff(request());
    expect(first).toHaveBeenCalledWith(request());
    expect(second).toHaveBeenCalledWith(request());
    offFirst();
    offFirst();
    expect(env.listeners.size).toBe(1);
    offSecond();
    expect(env.listeners.size).toBe(0);
  });

  it("keeps delivering when one listener throws", async () => {
    const env = createHost();
    const inbox = createOpenRequestInbox(env.host);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const healthy = vi.fn();
    inbox.onOpenRequest(() => { throw new Error("listener bug"); });
    inbox.onOpenRequest(healthy);
    await env.handOff(request());
    expect(healthy).toHaveBeenCalledWith(request());
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("bounds the number of listeners and rejects non-functions", () => {
    const inbox = createOpenRequestInbox(createHost().host);
    expect(() => inbox.onOpenRequest("nope" as unknown as () => void)).toThrow();
    for (let index = 0; index < OPEN_REQUEST_MAX_LISTENERS; index++) inbox.onOpenRequest(() => undefined);
    expect(() => inbox.onOpenRequest(() => undefined)).toThrow();
  });

  it("does not re-deliver a request the load path already returned", async () => {
    const env = createHost();
    env.values.set(OPEN_REQUEST_KV_KEY, request());
    const inbox = createOpenRequestInbox(env.host);
    const callback = vi.fn();
    inbox.onOpenRequest(callback);
    expect(await inbox.openRequest()).toEqual(request());
    // A late change event for the same request (the hand-off write) arrives after load.
    env.values.set(OPEN_REQUEST_KV_KEY, request());
    for (const listener of [...env.listeners]) listener(OPEN_REQUEST_KV_KEY, "docs");
    await settle();
    expect(callback).not.toHaveBeenCalled();
  });
});

describe("open request declaration for default apps", () => {
  it("repeats the fields of the contract", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const declaration = readFileSync(join(process.cwd(), "home/apps/_shared/matrix-os.d.ts"), "utf8");
    const start = declaration.indexOf("export interface OpenRequest {");
    const body = declaration.slice(start, declaration.indexOf("\n}\n", start));
    const fields = [...body.matchAll(/^ {2}(\w+): string;/gm)].map((match) => match[1]).sort();
    expect(fields).toEqual(Object.keys(OpenRequestSchema.shape).sort());
  });
});
