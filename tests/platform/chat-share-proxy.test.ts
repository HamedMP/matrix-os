import { expect, it } from "vitest";
import { parseChatShareRoute } from "../../packages/platform/src/chat-share-proxy";

it("accepts only an exact registered-runtime capability path", () => {
  const token = "a".repeat(64);
  expect(parseChatShareRoute(`/shared/chat/example/primary/${token}`)).toEqual({ handle: "example", runtimeSlot: "primary", token });
  for (const path of ["https://internal", `/shared/chat/example/primary/${token}/api/files`, `/shared/chat/../primary/${token}`, "/shared/chat/example/primary/no-token"]) {
    expect(parseChatShareRoute(path)).toBeNull();
  }
});

vi.mock("../../packages/platform/src/db.js", () => ({ getActiveUserMachineByHandle: vi.fn() }));
import { Hono } from "hono";
import { afterEach, vi } from "vitest";
import { getActiveUserMachineByHandle } from "../../packages/platform/src/db";
import { proxyChatShare } from "../../packages/platform/src/chat-share-proxy";
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.unstubAllEnvs(); });

it("isolates public readers before charging global relay capacity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 120_000);
  vi.stubEnv("K_SERVICE", "");
  vi.mocked(getActiveUserMachineByHandle).mockResolvedValue({ status: "running", publicIPv4: "203.0.113.10" } as never);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Shared", messages: [{ role: "user", text: "Hello" }] })));
  const app = new Hono();
  app.all("*", (c) => proxyChatShare(c, {} as never, {} as never));
  const path = "/shared/chat/example/primary/" + "a".repeat(64);
  const env = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
  for (let i = 0; i < 30; i++) expect((await app.request(path, {}, env("203.0.113.1"))).status).toBe(200);
  expect((await app.request(path, { headers: { "x-real-ip": "203.0.113.2", "x-forwarded-for": "203.0.113.2" } }, env("203.0.113.1"))).status).toBe(429);
  expect((await app.request(path, {}, env("203.0.113.2"))).status).toBe(200);
});

it("renders validated snapshots without forwarding caller credentials", async () => {
  vi.mocked(getActiveUserMachineByHandle).mockResolvedValue({ status: "running", publicIPv4: "203.0.113.10" } as never);
  const fetcher = vi.fn().mockResolvedValue(Response.json({ title: "<script>", messages: [{ role: "user", text: "<img onerror=alert(1)>" }] }));
  vi.stubGlobal("fetch", fetcher);
  const app = new Hono();
  app.all("*", (c) => proxyChatShare(c, {} as never, {} as never));
  const response = await app.request("/shared/chat/example/primary/" + "a".repeat(64), { headers: { authorization: "Bearer private", cookie: "session=private" } });
  expect(response.status).toBe(200);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://203.0.113.10:443/api/share/chats/" + "a".repeat(64));
  expect(await response.text()).toContain("&lt;img");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: { accept: "application/json" }, redirect: "error" });
  expect(Object.keys(fetcher.mock.calls[0]?.[1].headers)).toEqual(["accept"]);
  fetcher.mockResolvedValue(new Response("<script>arbitrary owner HTML</script>"));
  const unsafe = await app.request("/shared/chat/example/primary/" + "a".repeat(64));
  expect(unsafe.status).toBe(503);
  expect(await unsafe.text()).toBe("Shared Chat unavailable");
});

it("reserves relay concurrency for other readers and releases it after completion", async () => {
  vi.stubEnv("K_SERVICE", "");
  vi.mocked(getActiveUserMachineByHandle).mockResolvedValue({ status: "running", publicIPv4: "203.0.113.10" } as never);
  const finish: Array<() => void> = [];
  const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
    finish.push(() => resolve(Response.json({ title: "Shared", messages: [{ role: "user", text: "Hello" }] })));
  }));
  vi.stubGlobal("fetch", fetcher);
  const app = new Hono();
  app.all("*", (c) => proxyChatShare(c, {} as never, {} as never));
  const path = "/shared/chat/example/primary/" + "a".repeat(64);
  const env = (address: string) => ({ incoming: { socket: { remoteAddress: address } } });
  const first = app.request(path, {}, env("203.0.113.31"));
  const second = app.request(path, {}, env("203.0.113.31"));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect((await app.request(path, {}, env("203.0.113.31"))).status).toBe(429);
  const other = app.request(path, {}, env("203.0.113.32"));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  finish.forEach((resolve) => resolve());
  expect((await Promise.all([first, second, other])).map((response) => response.status)).toEqual([200, 200, 200]);
  fetcher.mockImplementation(async () => Response.json({ title: "Shared", messages: [{ role: "user", text: "Hello" }] }));
  expect((await app.request(path, {}, env("203.0.113.31"))).status).toBe(200);
});
