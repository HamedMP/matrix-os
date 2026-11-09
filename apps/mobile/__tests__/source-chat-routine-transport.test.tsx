import { ReadableStream } from "node:stream/web";
import { TextEncoder } from "node:util";
import { cleanup, render, screen } from "@testing-library/react-native";
import { fetch as expoFetch } from "expo/fetch";
import { ROUTINE_CHAT_ORIGIN_RESPONSE_MAX_BYTES, RoutineChatOriginViewSchema } from "@matrix-os/contracts";
import { createOwnerBrowserJsonRequest, createRoutineOriginClient } from "@matrix-os/ui/routine-origin";
import { NativeSourceChatRoutines } from "../components/chat/NativeSourceChatRoutines";

const mockGetToken = jest.fn(async () => "fixture-token");
jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: mockGetToken, userId: "owner", sessionId: "session" }),
}));
jest.mock("expo/fetch", () => ({ fetch: jest.fn() }));
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

afterEach(() => { cleanup(); jest.clearAllMocks(); jest.restoreAllMocks(); });

const encoder = new TextEncoder();
const chatId = "chat_source";
const gatewayUrl = "https://app.matrix-os.com/vm/fixture?runtime=primary";
function largeSourceBatch() {
  return RoutineChatOriginViewSchema.parse({
    sourceChatId: chatId, hasMore: false, deliveryPending: false,
    deliveries: Array.from({ length: 32 }, (_, index) => ({
      messageId: `msg_receipt_${index}`,
      receipt: {
        type: "routine_receipt", engine: "matrix", kind: "output", status: "completed", attempt: 1,
        routineId: "rt_0123456789abcdef01234567",
        fireId: `fire_${index.toString(16).padStart(24, "0")}`,
        scheduledFor: "2099-01-01T00:00:00.000Z",
        canonicalChatId: "chat_executor", canonicalTaskId: `task_fixture_${index}`, model: "gpt-6-luna",
      },
    })),
    pending: Array.from({ length: 32 }, (_, index) => ({
      sourceChatId: chatId, anchorMessageId: `msg_source_${index}`,
      interaction: {
        interactionId: `in_fixture_${index}`, chatId: "chat_executor", agentId: "bot_fixture01",
        taskId: `task_fixture_${index}`, kind: "approval", status: "pending", blocking: true,
        expiresAt: "2099-01-01T00:00:00.000Z", revision: 7,
        payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 3,
          argsDigest: "a".repeat(64),
          preview: JSON.stringify({
            proposal: { name: `Fixture ${index}`, prompt: "雪".repeat(4096),
              schedule: { kind: "interval", everyMs: 120000 },
              selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" },
              authorizedEffects: ["read"] },
            source: { computerId: "fixture", accountId: "fixture-account", grantRevision: 3, definitionRevision: 2 },
          }),
        },
      },
    })),
  });
}

function streamedResponse(bytes: Uint8Array, length: string | null = null) {
  let offset = 0;
  const cancel = jest.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(bytes.length, offset + 16 * 1024);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel,
  }, { highWaterMark: 0 });
  const response = { ok: true, headers: { get: () => length }, body } as unknown as Response;
  return { response, body, cancel };
}

it.each([true, false])("renders 32 approvals from the real Native Mobile transport (content length declared: %s)", async declared => {
  const bytes = encoder.encode(JSON.stringify(largeSourceBatch()));
  expect(bytes.byteLength).toBeGreaterThan(128 * 1024);
  const stream = streamedResponse(bytes, declared ? String(bytes.byteLength) : null);
  jest.mocked(expoFetch).mockResolvedValueOnce(stream.response as never);

  render(<NativeSourceChatRoutines gatewayUrl={gatewayUrl} chatId={chatId} eligible />);
  expect(await screen.findAllByRole("button", { name: "Review in browser" })).toHaveLength(32);
  expect(screen.getByRole("header", { name: "Schedule Fixture 31" })).toBeTruthy();
  expect(expoFetch).toHaveBeenCalledWith(
    "https://app.matrix-os.com/vm/fixture/~runtime/primary/api/chats/chat_source/routine-origin",
    expect.objectContaining({ method: "GET", headers: { authorization: "Bearer fixture-token" } }),
  );
  expect(stream.cancel).not.toHaveBeenCalled();
});

it.each(["missing", "understated", "oversized"])("cancels over-budget responses with %s content length", async header => {
  // Valid JSON if consumed completely. The untrusted padding must never reach parsing.
  const bytes = new Uint8Array(ROUTINE_CHAT_ORIGIN_RESPONSE_MAX_BYTES + 1).fill(32);
  bytes.set(encoder.encode(JSON.stringify(largeSourceBatch())));
  const declared = header === "missing" ? null : header === "understated" ? "1" : String(bytes.byteLength);
  const stream = streamedResponse(bytes, declared);
  jest.mocked(expoFetch).mockResolvedValueOnce(stream.response as never);
  jest.spyOn(console, "warn").mockImplementation(() => {});

  render(<NativeSourceChatRoutines gatewayUrl={gatewayUrl} chatId={chatId} eligible />);
  expect(await screen.findByRole("button", { name: "Refresh scheduled tasks" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review in browser" })).toBeNull();
  expect(stream.cancel).toHaveBeenCalledTimes(1);
  expect(stream.body.locked).toBe(false);
});

it("keeps the same bounded page available in the browser approval handoff", async () => {
  const page = largeSourceBatch();
  const stream = streamedResponse(encoder.encode(JSON.stringify(page)));
  const request = createOwnerBrowserJsonRequest("", mockGetToken,
    jest.fn(async () => stream.response), { cache: "no-store", allowRelative: true });
  const client = createRoutineOriginClient((path, method, body, options) => request({ path, method, body, signal: options?.signal }));
  await expect(client.get(chatId)).resolves.toEqual(page);
  expect(stream.cancel).not.toHaveBeenCalled();
});

it.each([
  { path: "/api/unrelated", method: "GET" },
  { path: "/api/chats/chat_source/routine-origin/in_fixture_0/resolve", method: "POST" },
  { path: "/api/chats/chat_source/routine-origin", method: "POST" },
] as const)("keeps the existing owner transport cap on $method $path", async ({ path, method }) => {
  const stream = streamedResponse(encoder.encode(JSON.stringify(largeSourceBatch())));
  const request = createOwnerBrowserJsonRequest("https://app.matrix-os.com/vm/fixture",
    mockGetToken, jest.fn(async () => stream.response));
  await expect(request({ path, method })).rejects.toThrow("Routine confirmation unavailable");
  expect(stream.cancel).toHaveBeenCalledTimes(1);
});
