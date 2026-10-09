import { expect, it, vi } from "vitest";
import { createAppAiRoutes } from "../../packages/gateway/src/app-ai/routes.js";
it("admits discovery before policy authorization reads", async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const authorize = vi.fn(async () => { await wait; return true; });
  const api = createAppAiRoutes({ authorize, generate: vi.fn(), discover: async () => ({ routes: [], defaultRoute: null }) });
  const first = api.request("/routes?app=notes"); const second = api.request("/routes?app=notes");
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
  const third = api.request("/routes?app=notes");
  try { await new Promise(resolve=>setTimeout(resolve,20));expect(authorize).toHaveBeenCalledTimes(2); }
  finally { release(); }
  expect((await third).status).toBe(429);expect((await first).status).toBe(200);expect((await second).status).toBe(200);
});
it("retains authorization slots after disconnect until ignored cancellation actually drains", async () => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const authorize = vi.fn(async () => { await wait; return true; });
  const discover = vi.fn(async () => ({ routes: [], defaultRoute: null }));
  const api = createAppAiRoutes({ authorize, generate: vi.fn(), discover });
  const controller = new AbortController();
  const first = api.request("/routes?app=notes", { signal: controller.signal }); const second = api.request("/routes?app=notes");
  await vi.waitFor(() => expect(authorize).toHaveBeenCalledTimes(2));
  try {
    controller.abort(); expect((await first).status).toBe(503);
    expect((await api.request("/routes?app=notes")).status).toBe(429); expect(authorize).toHaveBeenCalledTimes(2);
  } finally { release(); }
  expect((await second).status).toBe(200);
  expect((await api.request("/routes?app=notes")).status).toBe(200); expect(discover).toHaveBeenCalledTimes(2);
});
it("caps policy and exact-selection authorization reads in the request window", async () => {
  const authorize = vi.fn(async () => true); const authorizeSelection = vi.fn(async () => false);
  const api = createAppAiRoutes({ authorize, authorizeSelection, generate: vi.fn() });
  const post = () => api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "text" }) });
  for (let count = 0; count < 100; count++) expect((await post()).status).toBe(403);
  expect((await post()).status).toBe(429);
  expect(authorize).toHaveBeenCalledTimes(100); expect(authorizeSelection).toHaveBeenCalledTimes(100);
});
it.each(["owner", "app", "selection"])("keeps denied %s requests out of the authorized discovery/inference quota", async denied => {
  const authorize = vi.fn(async (c, app) => c.req.header("x-test-owner") !== "other" && app === "notes");
  const authorizeSelection = vi.fn(async request => request.prompt !== "denied selection");
  const generate = vi.fn(async () => ({ text: "approved" }));
  const discover = vi.fn(async () => ({ routes: [], defaultRoute: null }));
  const api = createAppAiRoutes({ authorize, authorizeSelection, generate, discover });
  for (let count = 0; count < 10; count++) {
    const response = denied === "selection"
      ? await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "denied selection" }) })
      : await api.request(`/routes?app=${denied === "app" ? "ungranted" : "notes"}`, { headers: denied === "owner" ? { "x-test-owner": "other" } : {} });
    expect(response.status).toBe(403);
  }
  expect(generate).not.toHaveBeenCalled(); expect(discover).not.toHaveBeenCalled();
  expect((await api.request("/routes?app=notes")).status).toBe(200);
  const post = () => api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "approved" }) });
  for (let count = 0; count < 9; count++) expect((await post()).status).toBe(200);
  expect((await post()).status).toBe(429);
  expect(generate).toHaveBeenCalledTimes(9); expect(discover).toHaveBeenCalledOnce();
});
it("bounds oversized bodies before authorization without consuming approved app quota", async () => {
  const authorize = vi.fn(async () => true); const generate = vi.fn(async () => ({ text: "approved" }));
  const api = createAppAiRoutes({ authorize, generate });
  for (let count = 0; count < 12; count++) {
    const response = await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "x".repeat(65536) }) });
    expect(response.status).toBe(413);
  }
  expect(authorize).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  for (let count = 0; count < 10; count++) expect((await api.request("/", { method: "POST", body: JSON.stringify({ app: "notes", prompt: "approved" }) })).status).toBe(200);
  expect(generate).toHaveBeenCalledTimes(10);
});
it("bounds nonowner denials separately without consuming owner policy or app AI budgets", async () => {
  const authorize = vi.fn(async () => true); const generate = vi.fn(async () => ({ text: "owner text" }));
  const api = createAppAiRoutes({ authorizeOwner: c => c.req.header("x-test-owner") !== "other", authorize, generate });
  const post = (owner: string) => api.request("/", { method: "POST", headers: { "x-test-owner": owner }, body: JSON.stringify({ app: "notes", prompt: "text" }) });
  for (let count = 0; count < 110; count++) expect((await post("other")).status).toBe(count < 100 ? 403 : 429);
  expect(authorize).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  for (let count = 0; count < 10; count++) expect((await post("owner")).status).toBe(200);
  expect((await post("owner")).status).toBe(429);
  expect(generate).toHaveBeenCalledTimes(10);
});
