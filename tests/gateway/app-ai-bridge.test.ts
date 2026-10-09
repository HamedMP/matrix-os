import { describe, expect, it, vi } from "vitest";
import { createAppAiRoutes } from "../../packages/gateway/src/app-ai/routes.js";

describe("app AI bridge", () => {
  const payload = { app: "brain", prompt: "Summarize these notes" };
  function setup(authorized = true) {
    const generate = vi.fn(async () => ({ text: "Summary" }));
    const authorize = vi.fn(async () => authorized);
    return { generate, authorize, app: createAppAiRoutes({ authorize, generate }) };
  }
  it("returns a text completion through the app route", async () => {
    const { app, generate } = setup();
    const response = await app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "Summary" });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining(payload), expect.any(AbortSignal));
  });
  it("denies access before invoking a model", async () => {
    const { app, generate } = setup(false);
    expect((await app.request("/", { method: "POST", body: JSON.stringify(payload) })).status).toBe(403);
    expect(generate).not.toHaveBeenCalled();
  });
  it.each([{ ...payload, app: "../system" }, { ...payload, prompt: "" }, { ...payload, url: "https://evil.test" }, { ...payload, tools: ["Bash"] }])("rejects malformed or privileged input %j", async (body) => {
    const { app, generate } = setup();
    expect((await app.request("/", { method: "POST", body: JSON.stringify(body) })).status).toBe(400);
    expect(generate).not.toHaveBeenCalled();
  });
  it("bounds request bodies before parsing", async () => {
    const { app, generate } = setup();
    expect((await app.request("/", { method: "POST", body: JSON.stringify({ ...payload, prompt: "x".repeat(70000) }) })).status).toBe(413);
    expect(generate).not.toHaveBeenCalled();
  });
  it("does not expose provider failures", async () => {
    const { app, generate } = setup();
    generate.mockRejectedValueOnce(new Error("secret provider key /home/private"));
    const response = await app.request("/", { method: "POST", body: JSON.stringify(payload) });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "App AI is unavailable" });
  });
});

it("caps concurrent generations and releases slots after completion", async () => {
  let finish!: (result: { text: string }) => void;
  const result = new Promise<{ text: string }>((resolve) => { finish = resolve; });
  const generate = vi.fn(() => result);
  const app = createAppAiRoutes({ authorize: async () => true, generate });
  const request = () => app.request("/", { method: "POST", body: '{"app":"brain","prompt":"notes"}' });
  const first = request();
  const second = request();
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  expect((await request()).status).toBe(429);
  finish({ text: "done" });
  expect((await first).status).toBe(200);
  expect((await second).status).toBe(200);
  expect((await request()).status).toBe(200);
});

it("returns on disconnect even if inference ignores abort, retaining the concurrency cap", async () => {
  let finish!: (result: { text: string }) => void;
  const pending = new Promise<{ text: string }>(resolve => { finish = resolve; });
  const generate = vi.fn(() => pending);
  const app = createAppAiRoutes({ authorize: async () => true, generate });
  const controller = new AbortController();
  const first = app.request("/", { method: "POST", signal: controller.signal, body: '{"app":"brain","prompt":"notes"}' });
  const second = app.request("/", { method: "POST", body: '{"app":"brain","prompt":"notes"}' });
  await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
  try {
    controller.abort(); expect((await first).status).toBe(503);
    expect((await app.request("/", { method: "POST", body: '{"app":"brain","prompt":"notes"}' })).status).toBe(429);
  } finally { finish({ text: "drained" }); }
  expect((await second).status).toBe(200);
  expect((await app.request("/", { method: "POST", body: '{"app":"brain","prompt":"notes"}' })).status).toBe(200);
});
it("bounds route discovery work and rejects duplicate app identity query values",async()=>{
  let finish!:(value:{routes:[];defaultRoute:null})=>void;
  const pending=new Promise<{routes:[];defaultRoute:null}>(resolve=>{finish=resolve;});
  const discover=vi.fn(()=>pending);
  const app=createAppAiRoutes({authorize:async()=>true,generate:async()=>({text:"ok"}),discover});
  const first=app.request("/routes?app=brain");const second=app.request("/routes?app=brain");
  await vi.waitFor(()=>expect(discover).toHaveBeenCalledTimes(2));
  expect((await Promise.race([app.request("/routes?app=brain"),new Promise<Response>(resolve=>setTimeout(()=>resolve(new Response(null,{status:599})),100))])).status).toBe(429);
  expect((await app.request("/routes?app=brain&app=other")).status).toBe(400);
  finish({routes:[],defaultRoute:null});await first;await second;
});
