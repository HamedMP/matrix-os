import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGetStartedBotNameRoutes } from "../../packages/platform/src/get-started-bot-names.js";
import { buildPlatformVerificationToken } from "../../packages/platform/src/platform-token.js";

const secret = "platform-secret-123";
const handle = "alice";
const path = `/internal/containers/${handle}/get-started/bot-names`;
const request = { goals: ["code", "business"], personality: "calm-mentor", exclude: ["Atlas", "Nova"] };
const modelNames = [
  { name: "Luna", emoji: "🌙" }, { name: "Ledger", emoji: "📒" }, { name: "Pixel", emoji: "👾" },
  { name: "Sage", emoji: "🦉" }, { name: "Orbit", emoji: "🪐" }, { name: "Kite", emoji: "🪁" },
];

function gemini(body: unknown, status = 200) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: typeof body === "string" ? body : JSON.stringify(body) }] } }] }), { status });
}

function setup(options: { key?: string | undefined; known?: boolean; fetchImpl?: typeof fetch; model?: string; now?: () => number } = {}) {
  const fetchImpl = options.fetchImpl ?? vi.fn(async () => gemini({ names: modelNames }));
  const resolveMachine = vi.fn(async (value: string) => (options.known === false || value !== handle ? null : { clerkUserId: "user_alice" }));
  const root = new Hono();
  root.route("/internal/containers/:handle/get-started/bot-names", createGetStartedBotNameRoutes({
    platformSecret: secret,
    resolveMachine,
    geminiApiKey: "key" in options ? options.key : "gemini-key-1",
    fetchImpl,
    ...(options.model ? { model: options.model } : {}),
    ...(options.now ? { now: options.now } : {}),
  }));
  const post = (body: unknown = request, bearer: string | null = buildPlatformVerificationToken(handle, secret), target = path) => root.request(target, {
    method: "POST",
    headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { post, fetchImpl: fetchImpl as ReturnType<typeof vi.fn>, resolveMachine };
}

afterEach(() => vi.restoreAllMocks());

describe("Platform Get started bot name suggestions", () => {
  it("asks the small model with Matrix's key in a header and returns five valid names", async () => {
    const { post, fetchImpl } = setup();
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ names: modelNames.slice(0, 5) });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent");
    expect(url).not.toContain("gemini-key-1");
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe("gemini-key-1");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const prompt = JSON.parse(String(init.body)).contents[0].parts[0].text as string;
    // Goals and personality reach the prompt only as fixed labels.
    expect(prompt).toContain("Write code with agents");
    expect(prompt).toContain("Run my business");
    expect(prompt).toContain("Calm mentor");
    expect(prompt).toContain("Atlas, Nova");
  });

  it("uses the configured model", async () => {
    const { post, fetchImpl } = setup({ model: "gemini-3.6-flash-lite" });
    await post();
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("/models/gemini-3.6-flash-lite:generateContent");
  });

  it("drops invalid, repeated and already shown names from the model before picking five", async () => {
    const reply = { names: [
      { name: "Atlas", emoji: "🧭" }, { name: "Luna", emoji: "🌙" }, { name: "luna", emoji: "🌕" }, { name: "R2D2", emoji: "🤖" },
      { name: "Ledger", emoji: "money" }, ...modelNames.slice(1),
    ] };
    const { post } = setup({ fetchImpl: vi.fn(async () => gemini(reply)) });
    expect(await (await post()).json()).toEqual({ names: [{ name: "Luna", emoji: "🌙" }, ...modelNames.slice(1, 5)] });
  });

  it("fails generically when the model errors, times out, or returns too few valid names", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const fetchImpl of [
      vi.fn(async () => new Response("quota exceeded for project 1234", { status: 429 })),
      vi.fn(async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }),
      vi.fn(async () => gemini("not json at all")),
      vi.fn(async () => gemini({ names: modelNames.slice(0, 3) })),
      vi.fn(async () => new Response("{}", { status: 200 })),
    ]) {
      const res = await setup({ fetchImpl: fetchImpl as unknown as typeof fetch }).post();
      expect(res.status).toBe(502);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "Name suggestions are unavailable" });
      expect(text).not.toMatch(/quota|1234|timed out|gemini/i);
    }
    expect(log).toHaveBeenCalled();
  });

  it("stops reading a model reply past 32 KiB instead of buffering it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let pulls = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(4096).fill(32)); },
    });
    const res = await setup({ fetchImpl: vi.fn(async () => new Response(endless, { status: 200 })) as unknown as typeof fetch }).post();
    expect(res.status).toBe(502);
    expect(pulls).toBeLessThan(20);
  });

  it("refuses a missing or wrong machine bearer before looking anything up", async () => {
    const { post, resolveMachine, fetchImpl } = setup();
    expect((await post(request, null)).status).toBe(401);
    expect((await post(request, buildPlatformVerificationToken("bob", secret))).status).toBe(401);
    expect(resolveMachine).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses unknown machines, bad handles and bad bodies", async () => {
    expect((await setup({ known: false }).post()).status).toBe(404);
    const { post, fetchImpl } = setup();
    expect((await post(request, buildPlatformVerificationToken("Bad_Handle", secret), "/internal/containers/Bad_Handle/get-started/bot-names")).status).toBe(400);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ ...request, personality: "evil-genius" })).status).toBe(400);
    expect((await post({ ...request, exclude: ["x".repeat(3000)] })).status).toBe(413);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("is unavailable without Matrix's model key", async () => {
    const { post, fetchImpl } = setup({ key: undefined });
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Name suggestions are unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("limits each machine to 30 requests an hour", async () => {
    let now = 1_000_000;
    const { post, fetchImpl } = setup({ now: () => now });
    for (let i = 0; i < 30; i += 1) expect((await post()).status).toBe(200);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Too many requests" });
    expect(fetchImpl).toHaveBeenCalledTimes(30);
    now += 60 * 60 * 1000;
    expect((await post()).status).toBe(200);
  });
});
