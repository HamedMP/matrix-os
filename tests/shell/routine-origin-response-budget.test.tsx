// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotInteraction } from "@matrix-os/contracts";
import { createCanonicalShellChatClient } from "../../shell/src/lib/canonical-chat-client.js";
import { RoutineOriginCompletion } from "../../shell/src/components/auth/RoutineOriginCompletion.js";
import { createRoutineOriginClient } from "../../packages/ui/src/chat/routine-origin-client.js";
import { createOwnerBrowserJsonRequest } from "../../packages/ui/src/routine-action/owner-browser-request.js";

vi.mock("../../shell/src/lib/gateway", () => ({ getGatewayUrl: () => "https://matrix.test" }));
const CHAT = "chat_source_budget", INTERACTION = "in_budget001";
const DECISION = { kind: "approval" as const, baseRevision: 1, decision: "approve" as const };
const ACK = { interaction: { interactionId: INTERACTION, status: "resolved", revision: 2 } };
const interaction: BotInteraction = { interactionId: INTERACTION, chatId: "chat_existing_bot", agentId: "bot_existing", taskId: "task_existing",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64),
    preview: JSON.stringify({ proposal: { name: "Response budget", prompt: "Synthetic fixture only", schedule: { kind: "interval", everyMs: 120000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "synthetic-model" }, authorizedEffects: ["read"] },
      source: { accountId: "synthetic-account", computerId: "synthetic-computer", grantRevision: 1, definitionRevision: 1 } }) } };
const view = (pending = true) => ({ sourceChatId: CHAT, pending: pending ? [{ sourceChatId: CHAT, anchorMessageId: "msg_source", interaction }] : [],
  deliveries: [], deliveryPending: false, hasMore: false });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Only the network response is controlled. Production creates the real
 * AbortSignal/deadline and the shared strict parser consumes the real Response. */
function delayed(init: RequestInit | undefined, body: unknown, delayMs?: number): Promise<Response> {
  const signal = init?.signal;
  if (!signal) throw new Error("The actual request signal is required");
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) { abort(); return; }
    if (delayMs !== undefined) timer = setTimeout(() => {
      signal.removeEventListener("abort", abort); resolve(Response.json(body));
    }, delayMs);
  });
}

// Named regression: treating the decision POST as an ordinary 10s read loses
// a legitimate committed-decision acknowledgement returned after 12s.
it("accepts a legitimate 12s source decision ACK through the real Web Desktop client and shared strict parser", async () => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => delayed(init, ACK, 12_000));
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: fetcher });
  const origin = client.agents!.bots!.routineOrigin!;
  await expect(origin.resolve(CHAT, INTERACTION, DECISION)).resolves.toEqual(ACK);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![0]).toBe(`https://matrix.test/api/chats/${CHAT}/routine-origin/${INTERACTION}/resolve`);
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(false);
}, 20_000);

const ENTRIES = ["Web Desktop", "owner browser"] as const;
function originClient(entry: typeof ENTRIES[number], fetcher: typeof fetch) {
  if (entry === "Web Desktop") return createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: fetcher }).agents!.bots!.routineOrigin!;
  const request = createOwnerBrowserJsonRequest("https://matrix.test", async () => null, fetcher);
  return createRoutineOriginClient((path, method, body, options) => request({ path, method, body, ...options }));
}

it.each(ENTRIES)("bounds a hanging %s decision at 30s without resubmitting it", async entry => {
  const caller = new AbortController();
  const fetcher = vi.fn<typeof fetch>((_url, init) => delayed(init, ACK));
  let settled = false;
  const result = originClient(entry, fetcher).resolve(CHAT, INTERACTION, DECISION, caller.signal)
    .then(() => { settled = true; return "resolved"; }, () => { settled = true; return "rejected"; });
  let guard: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<string>(resolve => { guard = setTimeout(() => resolve("unbounded"), 31_000); });
  try {
    await new Promise(resolve => setTimeout(resolve, 12_000));
    expect(settled).toBe(false);
    expect(await Promise.race([result, bound])).toBe("rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
  } finally { clearTimeout(guard); caller.abort(); await result; }
}, 40_000);

it.each(ENTRIES)("honors explicit caller cancellation for a %s decision without retry", async entry => {
  const caller = new AbortController();
  const fetcher = vi.fn<typeof fetch>((_url, init) => delayed(init, ACK));
  const result = originClient(entry, fetcher).resolve(CHAT, INTERACTION, DECISION, caller.signal).catch(() => "cancelled");
  await Promise.resolve(); // Owner transport obtains its token before fetch.
  await Promise.resolve();
  caller.abort();
  expect(await result).toBe("cancelled");
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
});

it.each(ENTRIES)("retains the ordinary 10s read deadline for %s source-origin reads", async entry => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => delayed(init, view(), 12_000));
  await expect(originClient(entry, fetcher).get(CHAT)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
}, 15_000);

it("retains the ordinary 10s deadline for another Bot decision POST", async () => {
  const fetcher = vi.fn<typeof fetch>((_url, init) => delayed(init, ACK, 12_000));
  const client = createCanonicalShellChatClient({ gatewayUrl: "https://matrix.test", fetchFn: fetcher });
  await expect(client.agents!.bots!.resolve(CHAT, INTERACTION, DECISION)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true);
}, 15_000);

it("accepts a legitimate 12s source decision ACK through the actual owner-browser completion component", async () => {
  let decided = false;
  const postSignals: AbortSignal[] = [];
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") return Response.json(view(!decided));
    if (!init.signal) throw new Error("Actual owner-browser signal required");
    postSignals.push(init.signal);
    const response = await delayed(init, ACK, 12_000); decided = true; return response;
  });
  vi.stubGlobal("fetch", fetcher);
  render(<RoutineOriginCompletion chatId={CHAT} interactionId={INTERACTION} getToken={async () => null} identity="synthetic-owner"/>);
  fireEvent.click(await screen.findByRole("button", { name: "Approve schedule" }));
  // Pending itself hides buttons. Wait for the post-ACK source read to close
  // the review, rather than mistaking the submitting state for success.
  await screen.findByText("This review is closed or unavailable. Return to the source Chat to check current status.", {}, { timeout: 15_000 });
  expect(screen.queryByText(/Your decision could not be confirmed/)).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(postSignals).toHaveLength(1);
  expect(postSignals[0]!.aborted).toBe(false);
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
}, 20_000);
