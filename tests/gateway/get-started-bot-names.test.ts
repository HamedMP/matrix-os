import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { GetStartedBotNamesRequest } from "../../packages/contracts/src/index.js";
import { createGetStartedRoutes } from "../../packages/gateway/src/routes/get-started.js";
import { createGetStartedBotNameClient, GetStartedBotNameClientError } from "../../packages/gateway/src/get-started/bot-names-client.js";

const NOW = new Date("2026-10-25T10:12:00.000Z");
const names = [
  { name: "Luna", emoji: "🌙" }, { name: "Ledger", emoji: "📒" }, { name: "Pixel", emoji: "👾" },
  { name: "Sage", emoji: "🦉" }, { name: "Orbit", emoji: "🪐" },
];
const body = { goals: ["code"], personality: "calm-mentor", exclude: ["Atlas"] };

describe("POST /api/settings/get-started/bot-names", () => {
  let homePath: string;

  function app(options: { enabled?: boolean; suggest?: (request: GetStartedBotNamesRequest, signal: AbortSignal) => Promise<unknown> } = {}) {
    const root = new Hono();
    root.route("/api/settings/get-started", createGetStartedRoutes({
      homePath, enabled: options.enabled ?? true, now: () => NOW,
      ...(options.suggest ? { suggestBotNames: options.suggest as never } : {}),
    }));
    return root;
  }

  function post(root: Hono, value: unknown = body) {
    return root.request("/api/settings/get-started/bot-names", {
      method: "POST", headers: { "content-type": "application/json" },
      body: typeof value === "string" ? value : JSON.stringify(value),
    });
  }

  async function seed(state: unknown) {
    await writeFile(join(homePath, "system", "get-started.json"), JSON.stringify(state));
  }

  beforeEach(async () => {
    homePath = resolve(await mkdtemp(join(tmpdir(), "get-started-names-")));
    await mkdir(join(homePath, "system"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(homePath, { recursive: true, force: true });
  });

  it("asks the platform for names while setup is open", async () => {
    await seed({ version: 1, status: "in_progress", updatedAt: NOW.toISOString(), draft: { step: 4, goals: ["code"], tools: [] } });
    const suggest = vi.fn(async () => ({ names }));
    const res = await post(app({ suggest }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names });
    expect(suggest).toHaveBeenCalledWith(body, expect.any(AbortSignal));
  });

  it("is not available to homes that are not eligible, or once setup has ended", async () => {
    const suggest = vi.fn(async () => ({ names }));
    expect((await post(app({ suggest }))).status).toBe(404);
    await seed({ version: 1, status: "pending" });
    expect((await post(app({ suggest, enabled: false }))).status).toBe(404);
    await seed({ version: 1, status: "completed", completedAt: NOW.toISOString(), answers: { goals: [], tools: [] } });
    expect((await post(app({ suggest }))).status).toBe(409);
    await seed({ version: 1, status: "skipped", skippedAt: NOW.toISOString() });
    expect((await post(app({ suggest }))).status).toBe(409);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("validates the request before asking anyone", async () => {
    await seed({ version: 1, status: "pending" });
    const suggest = vi.fn(async () => ({ names }));
    const root = app({ suggest });
    expect((await post(root, "{nope")).status).toBe(400);
    expect((await post(root, { ...body, personality: "evil-genius" })).status).toBe(400);
    expect((await post(root, { ...body, prompt: "hi" })).status).toBe(400);
    expect((await post(root, { ...body, exclude: ["x".repeat(3000)] })).status).toBe(413);
    expect(suggest).not.toHaveBeenCalled();
  });

  it("returns a generic 503 when this computer cannot reach suggestions", async () => {
    await seed({ version: 1, status: "pending" });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unconfigured = await post(app());
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "Name suggestions are unavailable" });
    for (const suggest of [
      vi.fn(async () => { throw new GetStartedBotNameClientError("platform said 502: gemini quota"); }),
      vi.fn(async () => { throw new Error("ECONNREFUSED 10.0.0.1:443"); }),
    ]) {
      const res = await post(app({ suggest }));
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Name suggestions are unavailable" });
      expect(text).not.toMatch(/gemini|ECONNREFUSED|10\.0\.0\.1/);
    }
  });
});

describe("Gateway bot name client", () => {
  const request = { goals: ["code" as const], personality: "calm-mentor" as const, exclude: [] };

  it("calls the platform route for this computer with its machine bearer", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ names }), { status: 200 }));
    const client = createGetStartedBotNameClient({ platformUrl: "https://platform.example.test", token: "t".repeat(40), handle: "alice", fetchImpl });
    expect(client).not.toBeNull();
    const signal = new AbortController().signal;
    expect(await client!.suggest(request, signal)).toEqual({ names });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://platform.example.test/internal/containers/alice/get-started/bot-names");
    expect(init).toMatchObject({ method: "POST", redirect: "error", body: JSON.stringify(request) });
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${"t".repeat(40)}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal).not.toBe(signal);
  });

  it("is absent unless this computer has a platform URL, token and handle", () => {
    const fetchImpl = vi.fn();
    for (const config of [
      { platformUrl: undefined, token: "t".repeat(40), handle: "alice" },
      { platformUrl: "https://platform.example.test", token: undefined, handle: "alice" },
      { platformUrl: "https://platform.example.test", token: "t".repeat(40), handle: undefined },
      { platformUrl: "http://platform.example.test", token: "t".repeat(40), handle: "alice" },
      { platformUrl: "https://platform.example.test/path?x=1", token: "t".repeat(40), handle: "alice" },
      { platformUrl: "https://platform.example.test", token: "t".repeat(40), handle: "../alice" },
    ]) {
      expect(createGetStartedBotNameClient({ ...config, fetchImpl: fetchImpl as unknown as typeof fetch }), JSON.stringify(config)).toBeNull();
    }
    expect(createGetStartedBotNameClient({ platformUrl: "http://127.0.0.1:9000", token: "t".repeat(40), handle: "alice", fetchImpl: fetchImpl as unknown as typeof fetch })).not.toBeNull();
  });

  it("stops reading a platform reply past 32 KiB instead of buffering it", async () => {
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(4096).fill(32)); },
    });
    const client = createGetStartedBotNameClient({ platformUrl: "https://platform.example.test", token: "t".repeat(40), handle: "alice", fetchImpl: vi.fn(async () => new Response(endless, { status: 200 })) });
    await expect(client!.suggest(request, new AbortController().signal)).rejects.toBeInstanceOf(GetStartedBotNameClientError);
    expect(pulls).toBeLessThan(20);
  });

  it("rejects platform failures and answers that are not five valid names", async () => {
    for (const response of [
      new Response("{}", { status: 502 }),
      new Response(JSON.stringify({ names: names.slice(0, 2) }), { status: 200 }),
      new Response("not json", { status: 200 }),
      new Response(JSON.stringify({ names, padding: "x".repeat(40_000) }), { status: 200 }),
    ]) {
      const client = createGetStartedBotNameClient({ platformUrl: "https://platform.example.test", token: "t".repeat(40), handle: "alice", fetchImpl: vi.fn(async () => response) });
      await expect(client!.suggest(request, new AbortController().signal)).rejects.toBeInstanceOf(GetStartedBotNameClientError);
    }
  });
});
