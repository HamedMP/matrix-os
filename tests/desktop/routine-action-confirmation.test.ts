import { afterEach, expect, it, vi } from "vitest";
import { ROUTINE_ACTION_NOTICE, ROUTINE_ACTION_PATH } from "@matrix-os/contracts";
import { createRoutineActionClient } from "@matrix-os/ui/routine-action";
import { createApiClient, type ApiClientOptions } from "../../desktop/src/renderer/src/lib/api";
const mocks = vi.hoisted(() => ({ state: {} as Record<string, unknown>, invoke: vi.fn() }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: { getState: () => mocks.state } }));
vi.mock("../../desktop/src/renderer/src/lib/operator", () => ({ invoke: mocks.invoke }));
import { openDesktopRoutineConfirmation, desktopRoutineActionRequest } from "../../desktop/src/renderer/src/features/chat/routine-action-confirmation";
const id = `rcact_${"a".repeat(32)}`;
afterEach(() => vi.resetAllMocks());

function nativeClient(fetchFn: NonNullable<ApiClientOptions["fetchFn"]>) {
  const platformHost = "https://app.example.test", runtimeSlot = "review1";
  const api = createApiClient({ baseUrl: platformHost, getRuntimeSlot: () => runtimeSlot, fetchFn });
  mocks.state = { status: "signed-in", api, platformHost, runtimeSlot, userId: "owner", authGeneration: 3 };
  mocks.invoke.mockResolvedValue({
    items: [{ handle: "review-pc", runtimeSlot, label: "Additional Computer", availability: "available", kind: "customer",
      gatewayPath: "/vm/review-pc?runtime=review1", capabilities: [] }],
    hasMore: false, limit: 20, selectedSlot: runtimeSlot,
  });
  return createRoutineActionClient(desktopRoutineActionRequest);
}

function streamedResponse(body: string, cancel?: () => void) {
  const bytes = new TextEncoder().encode(body);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.byteLength) {
        if (!cancel) controller.close();
        return;
      }
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      controller.enqueue(chunk);
      offset += chunk.byteLength;
    },
    cancel,
  }));
}

it("reads a full valid Terminal inbox over Electron's bounded streaming transport", async () => {
  const challenges = Array.from({ length: 128 }, (_, index) => ({
    challengeId: `rcact_${index.toString(16).padStart(32, "0")}`, actionDigest: "d".repeat(64),
    sourceKind: "terminal_launch", operation: "propose", title: "Allow routine propose?", status: "pending",
    intent: { operation: "propose", requestId: "de000000-0000-4000-8000-000000000001", proposal: {
      name: "Large confirmation", prompt: "\u0001".repeat(2780), schedule: { kind: "interval", everyMs: 60_000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "fixture-model" }, authorizedEffects: ["read"],
    } },
    expiresAt: new Date(Date.now() + 120_000).toISOString(), target: { botId: "bot_target", chatId: "chat_target" },
    sourceLabel: "Terminal terminal_one", description: ROUTINE_ACTION_NOTICE,
  }));
  const json = JSON.stringify({ challenges });
  expect(json.length).toBeGreaterThan(128 * 1024);
  const body = json.padEnd(3 * 1024 * 1024, " ");
  const fetchFn = vi.fn(async () => streamedResponse(body));
  const client = nativeClient(fetchFn);
  await expect(client.list(new AbortController().signal)).resolves.toEqual(challenges);
  expect(fetchFn).toHaveBeenCalledWith(`https://app.example.test/vm/review-pc/~runtime/review1${ROUTINE_ACTION_PATH}`, expect.objectContaining({ method: "GET" }));
});

it.each(["list", "read", "submit"] as const)("cancels an oversized streamed %s response", async operation => {
  const limit = operation === "list" ? 3 * 1024 * 1024 : 128 * 1024;
  const cancel = vi.fn(), body = JSON.stringify(operation === "list" ? { challenges: [] } : { submission: "accepted" });
  const client = nativeClient(async () => streamedResponse(body.padEnd(limit + 1, " "), cancel));
  const signal = new AbortController().signal;
  const result = operation === "list" ? client.list(signal) : operation === "read" ? client.read(id, signal)
    : client.submit(id, { actionDigest: "a".repeat(64), decision: "approve", clientRequestId: "de000000-0000-4000-8000-000000000001" }, signal);
  await expect(result).rejects.toMatchObject({ category: "server", cause: { message: "file_too_large" } });
  expect(cancel).toHaveBeenCalledOnce();
});

it("rejects a corrupt streamed inbox without exposing its body", async () => {
  const client = nativeClient(async () => streamedResponse('{"challenges":[broken'));
  await expect(client.list(new AbortController().signal)).rejects.toMatchObject({
    category: "server", message: "Something went wrong. Please try again.", cause: expect.any(SyntaxError),
  });
});

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
