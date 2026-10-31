import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, invoke: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: { getState: () => mocks.state } }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: mocks.invoke }));
import { openDesktopRoutineConfirmation, desktopRoutineActionRequest } from "../../desktop/src/renderer/src/features/chat/routine-action-confirmation";
const id = `rcact_${"a".repeat(32)}`;
afterEach(() => vi.resetAllMocks());
it("pins the actual Computer descriptor/runtime and configured app origin; opening is no owner decision", async () => {
  const get = vi.fn(async () => ({ challengeId: id, actionDigest: "a".repeat(64), sourceKind: "chat_run", operation: "pause", status: "pending", title: "Allow routine pause?",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), intent: { operation: "pause", routineId: `rt_${"b".repeat(24)}`, requestId: "de000000-0000-4000-8000-000000000001", baseRevision: 1 },
    target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Chat chat_source", description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." }));
  const post = vi.fn(), api = { get, post, forRuntime: vi.fn(() => api) };
  mocks.state = { status: "signed-in", api, platformHost: "https://app.example.test", runtimeSlot: "review1", userId: "owner", authGeneration: 3 };
  mocks.invoke.mockImplementation(async (channel: string) => channel === "runtime:list-computers"
    ? { items: [{ handle: "review-pc", runtimeSlot: "review1", label: "Additional Computer", availability: "available", kind: "customer", gatewayPath: "/vm/review-pc?runtime=review1", capabilities: [] }], hasMore: false, limit: 20, selectedSlot: "review1" } : undefined);
  await openDesktopRoutineConfirmation(id);
  expect(get).toHaveBeenCalledWith(`/vm/review-pc/~runtime/review1/api/routine-cli/actions/${id}`, expect.any(Object));
  expect(mocks.invoke).toHaveBeenCalledWith("shell:open-external", { url: `https://app.example.test/vm/review-pc/routine-cli/confirm?runtime=review1&challenge=${id}` });
  expect(post).not.toHaveBeenCalled();
  await desktopRoutineActionRequest({ path: "/api/routine-cli/actions", method: "GET", signal: new AbortController().signal });
  expect(get).toHaveBeenLastCalledWith("/vm/review-pc/~runtime/review1/api/routine-cli/actions", expect.any(Object));
});
it("an owner/Computer switch during descriptor lookup prevents late browser opening", async () => {
  const api = { forRuntime: vi.fn(), get: vi.fn() };
  mocks.state = { status: "signed-in", api, platformHost: "https://app.example.test", runtimeSlot: "review1", userId: "owner", authGeneration: 3 };
  mocks.invoke.mockImplementation(async () => { mocks.state = { ...mocks.state, authGeneration: 4 }; return { items: [], hasMore: false, limit: 20, selectedSlot: null }; });
  await expect(openDesktopRoutineConfirmation(id)).rejects.toThrow("Confirmation unavailable");
  expect(mocks.invoke).toHaveBeenCalledTimes(1); expect(api.get).not.toHaveBeenCalled();
});

it("does not open after the owning card aborts while the challenge read is pending", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const get = vi.fn(async () => { await pending; return { challengeId: id, actionDigest: "a".repeat(64), sourceKind: "chat_run", operation: "pause", status: "pending", title: "Allow routine pause?",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), intent: { operation: "pause", routineId: `rt_${"b".repeat(24)}`, requestId: "de000000-0000-4000-8000-000000000001", baseRevision: 1 },
    target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Chat chat_source", description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." }; });
  const api = { get, forRuntime: vi.fn(() => api) };
  mocks.state = { status: "signed-in", api, platformHost: "https://app.example.test", runtimeSlot: "review1", userId: "owner", authGeneration: 3 };
  mocks.invoke.mockImplementation(async (channel: string) => channel === "runtime:list-computers"
    ? { items: [{ handle: "review-pc", runtimeSlot: "review1", label: "Additional Computer", availability: "available", kind: "customer", gatewayPath: "/vm/review-pc?runtime=review1", capabilities: [] }], hasMore: false, limit: 20, selectedSlot: "review1" } : undefined);
  const abort = new AbortController();
  const opening = openDesktopRoutineConfirmation(id, abort.signal);
  await vi.waitFor(() => expect(get).toHaveBeenCalledOnce());
  abort.abort(); release();
  await expect(opening).rejects.toThrow();
  expect(mocks.invoke.mock.calls.filter(([channel]) => channel === "shell:open-external")).toHaveLength(0);
});
