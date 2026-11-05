import { expect, it, vi } from "vitest";
import { createRoutineFullAccessBrowserClient, createRoutineFullAccessClient, routineFullAccessOwnerUrl } from "../../packages/ui/src/routine-action/full-access-client";

const status = { revision: 0, eligibility: "eligible", origin: "browser_required", consent: null, challenge: null };
it("validates the server DTO and sends strict scope decisions to the canonical Chat path", async () => {
  const request = vi.fn(async () => status), client = createRoutineFullAccessClient(request), signal = new AbortController().signal;
  const id = `rcfull_${"a".repeat(32)}`;
  await client.challenge("chat_source", 0, signal);
  expect(request).toHaveBeenLastCalledWith({ path: "/api/chats/chat_source/routine-cli/full-access/challenges", method: "POST", body: { baseRevision: 0 }, signal });
  const body = { scopeDigest: "b".repeat(64), decision: "approve" as const, clientRequestId: "de000000-0000-4000-8000-000000000001" };
  await client.decide("chat_source", id, body, signal);
  expect(request).toHaveBeenLastCalledWith({ path: `/api/chats/chat_source/routine-cli/full-access/challenges/${id}/decision`, method: "POST", body, signal });
  await expect(client.decide("chat_source", id, { ...body, ownerId: "forged" } as typeof body, signal)).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(2);
});
it("rejects malformed or authority-looking response fields instead of keeping them in UI state", async () => {
  const client = createRoutineFullAccessClient(async () => ({ ...status, proof: "forged" }));
  await expect(client.read("chat_source")).rejects.toThrow();
});
it("constructs only the configured HTTPS owner page with the selected Computer/runtime and Chat", () => {
  expect(routineFullAccessOwnerUrl("https://app.example.test", "/vm/dev-pc?runtime=review1", "chat_source"))
    .toBe("https://app.example.test/vm/dev-pc/routine-cli/full-access?runtime=review1&chat=chat_source");
  for (const path of ["https://evil.example/vm/dev-pc", "//evil.example/vm/dev-pc", "/vm/%64ev-pc", "/vm/dev-pc?token=secret", "/vm/dev-pc?runtime=one&runtime=two", "/vm/dev-pc#allow", "/"])
    expect(() => routineFullAccessOwnerUrl("https://app.example.test", path, "chat_source")).toThrow();
  for (const origin of ["http://app.example.test", "https://app.example.test/path", "https://user:pass@app.example.test"])
    expect(() => routineFullAccessOwnerUrl(origin, "/vm/dev-pc", "chat_source")).toThrow();
});

it("uses uncached bounded same-origin reads with only an optional owner token", async () => {
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json(status));
  const client = createRoutineFullAccessBrowserClient("", fetcher);
  await client.read("chat_source");
  expect(fetcher).toHaveBeenCalledWith("/api/chats/chat_source/routine-cli/full-access", expect.objectContaining({ cache: "no-store", credentials: "same-origin", redirect: "error" }));
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).has("x-matrix-routine-full-access-proof")).toBe(false);
});
it("aborts a token wait without sending and rejects oversized server views", async () => {
  const fetcher = vi.fn(async () => Response.json(status));
  const client = createRoutineFullAccessBrowserClient("https://matrix.test", fetcher, () => new Promise<string>(() => {}));
  const abort = new AbortController(), read = client.read("chat_source", abort.signal);
  const rejected = expect(read).rejects.toThrow(); abort.abort(); await rejected;
  expect(fetcher).not.toHaveBeenCalled();
  const huge = createRoutineFullAccessBrowserClient("https://matrix.test", async () => new Response("x".repeat(129 * 1024)));
  await expect(huge.read("chat_source")).rejects.toThrow();
});
