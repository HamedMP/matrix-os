import { afterEach, expect, it, vi } from "vitest";
import { createApiClient } from "../../desktop/src/renderer/src/lib/api";
type TestIdentity = { status: "signed-in"; userId: string; handle: string; platformHost: string; runtimeSlot: string;
  authGeneration: number; api: ReturnType<typeof createApiClient> };
const h = vi.hoisted(() => ({ identity: null as TestIdentity | null }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: { getState: () => h.identity } }));
import { createDesktopAoedeTransport } from "../../desktop/src/renderer/src/features/aoede/transport";
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("pins speech HTTP and approval writes to the selected computer and rejects old-owner closures", async () => {
  const writes: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    writes.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ approvalId: "approval_1", decision: "decline", submission: "accepted" });
  });
  const api = createApiClient({ baseUrl: "https://platform.example", getRuntimeSlot: () => h.identity!.runtimeSlot });
  h.identity = { status: "signed-in", userId: "owner-a", handle: "a", platformHost: "https://platform.example", runtimeSlot: "pr-42", authGeneration: 7, api };
  const transport = createDesktopAoedeTransport();
  await transport.fetchFn("https://platform.example/api/aoede/session", { method: "POST", body: "{}" });
  const card = { id: "card", chatId: "chat_1", runId: "run_1", title: "Read", status: "approval" as const,
    approval: { approvalId: "approval_1", title: "Read", description: "Read", risk: "low" as const, allowedDecisions: ["deny" as const] } };
  expect(await transport.submitApproval(card, "deny", "req_decision")).toBe(true);
  expect(new URL(writes[0].url).searchParams.get("runtime")).toBe("pr-42");
  expect(new URL(writes[1].url).pathname).toBe("/api/chats/chat_1/runs/run_1/approvals/approval_1");
  expect(new URL(writes[1].url).searchParams.get("runtime")).toBe("pr-42");
  expect(writes[1].body).toEqual({ clientRequestId: "req_decision", decision: "decline" });
  writes.length = 0;
  h.identity = { ...h.identity, authGeneration: 8 };
  await expect(transport.fetchFn("https://platform.example/api/aoede/session")).rejects.toThrow("AoedeIdentityChanged");
  await expect(transport.submitApproval(card, "deny", "req_decision")).rejects.toThrow("AoedeIdentityChanged");
  expect(writes).toEqual([]);
});
