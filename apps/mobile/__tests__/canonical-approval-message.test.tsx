import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";
import { useChatThread } from "@/components/chat/use-chat-thread";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";
import { supervisedToolApprovalCopy, type CanonicalChatApprovalDecision } from "@matrix-os/contracts";

jest.mock("expo/fetch", () => ({ fetch: (...args: Parameters<typeof fetch>) => fetch(...args) }));
const mockRoutineAuth = { userId: "owner-a", sessionId: "session-a", token: null as Promise<string> | null };
jest.mock("@clerk/clerk-expo", () => { const getToken = () => mockRoutineAuth.token ?? Promise.resolve("test-token");
  return { useAuth: () => ({ getToken, userId: mockRoutineAuth.userId, sessionId: mockRoutineAuth.sessionId }) }; });
// Unrelated ESM-only export from the contracts barrel; this suite exercises approval HTTP, not shared HTML.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }));
jest.mock("@/lib/queries/use-cancel-run", () => ({ useCancelRun: () => ({ mutate: jest.fn(), isPending: false }) }));
jest.mock("@/lib/queries/use-retry-chat-turn", () => ({ useRetryChatTurn: () => ({ mutate: jest.fn(), isPending: false, isError: false }) }));

const approval = {
  id: "evt_approval", runId: "run_test", approvalId: "approval_test", title: "Use integration",
  description: "The agent is waiting for your decision.", risk: "high" as const,
  allowedDecisions: ["approve", "decline", "cancel"] as const, pending: true, timestamp: 0,
};
const refresh = jest.fn();
const props = { chatId: "chat_test", gatewayUrl: "https://app.matrix-os.com/vm/pr-1580", onSettled: refresh };

afterEach(() => { jest.restoreAllMocks(); refresh.mockClear(); mockRoutineAuth.userId = "owner-a"; mockRoutineAuth.sessionId = "session-a"; mockRoutineAuth.token = null; });

it("submits the same approval decision with a renewed token after wake", async () => {
  jest.useFakeTimers();
  jest.spyOn(Math, "random").mockReturnValue(0);
  const transport = jest.spyOn(global, "fetch").mockImplementationOnce(async () => {
    mockRoutineAuth.token = Promise.resolve("renewed");
    return new Response('{"runtimeState":"waking"}', { status: 503, headers: { "Retry-After": "1" } });
  }).mockImplementationOnce(async (_url, init) => {
    const valid = new Headers(init?.headers).get("authorization") === "Bearer renewed";
    return new Response(JSON.stringify({ approvalId: "approval_test", decision: "approve", submission: "accepted" }), { status: valid ? 200 : 401 });
  });
  try {
    render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
    fireEvent.press(screen.getByText("Allow once"));
    await act(async () => { await jest.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText("Decision submitted. Waiting for confirmation.")).toBeTruthy();
    expect(transport.mock.calls[1]?.[1]?.body).toBe(transport.mock.calls[0]?.[1]?.body);
  } finally {
    jest.useRealTimers();
  }
});

it("submits a one-time decision to the selected chat and run, then refreshes", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "decline", submission: "accepted" }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Not now"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock).toHaveBeenCalledWith(
    "https://app.matrix-os.com/vm/pr-1580/api/chats/chat_test/runs/run_test/approvals/approval_test",
    expect.objectContaining({ method: "POST", body: expect.stringContaining('"decision":"decline"'), signal: expect.anything() }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalled());
});

it("forwards the pending approval's action digest for a bounded Drive action", async () => {
  const actionDigest = "c".repeat(64);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true,
    json: async () => ({ approvalId: "approval_test", decision: "approve", submission: "accepted" }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, actionDigest,
    allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Allow once"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const request = fetchMock.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body))).toMatchObject({ actionDigest, decision: "approve" });
});

it("does not render action buttons on a settled approval", () => {
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, pending: false, allowedDecisions: [...approval.allowedDecisions] }} />);
  expect(screen.queryByText("Allow once")).toBeNull();
  expect(screen.getByText("Approval ended without a recorded decision")).toBeTruthy();
});

it.each([["approve", "Approved"], ["approve_for_session", "Approved"], ["decline", "Declined"], ["cancel", "Cancelled"]] as const)("renders recorded %s in Native Mobile", (decision, label) => {
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, decision, pending: false, allowedDecisions: [...approval.allowedDecisions] }} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText("Allow once")).toBeNull();
});

it("keeps an accepted submission neutral until the recorded decision arrives", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "approve", submission: "accepted" }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Allow once"));
  await waitFor(() => expect(screen.getByText("Decision submitted. Waiting for confirmation.")).toBeTruthy());
  expect(screen.queryByText("Approved")).toBeNull();
});

it("keeps failed submissions recoverable and never displays a raw server error", async () => {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("private upstream token"));
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Cancel request"));
  await waitFor(() => expect(screen.getByText("Could not submit approval. Try again.")).toBeTruthy());
  expect(screen.queryByText("private upstream token")).toBeNull();
});

it("recovers authoritative browser access without a recorded grant activity", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ grant: init?.method === "DELETE" ? { ...grant, state: "revoked", revision: 2, revokedAt: new Date().toISOString() } : grant }) }) as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions], browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() } }} />);
  expect(screen.getByText("Needs your approval")).toBeTruthy();
  fireEvent.press(await screen.findByText("Undo"));
  await screen.findByText("Remembered browser access removed");
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/browser-grants/278ca19d-9760-4e67-a221-62bedf393b90"), expect.objectContaining({ method: "DELETE", body: expect.stringContaining('"baseRevision":1') }));
});
it("checks saved browser access after an uncertain native decision", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: async () => ({ grant: null }) } as Response)
    .mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue({ ok: true, json: async () => ({ grant }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, actionDigest: "a".repeat(64), allowedDecisions: [...approval.allowedDecisions], browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() } }} />);
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  fireEvent.press(screen.getByText("Allow in this Chat"));
  await screen.findByText("Undo");
  expect(screen.getByText("Could not submit approval. Try again.")).toBeTruthy();
});
it("releases Undo busy state when Chat refreshes during the request", async () => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  let rejectUndo!: (error: Error) => void;
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") return await new Promise((_resolve, reject) => { rejectUndo = reject; });
    return { ok: true, json: async () => ({ grant }) } as Response;
  });
  const view = { ...approval, allowedDecisions: [...approval.allowedDecisions], browserApproval: { kind: "shared_chrome" as const, leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 as const, expiresAt: new Date(Date.now()+60_000).toISOString() } };
  const { rerender } = render(<CanonicalApprovalMessage {...props} approval={view}/>);
  fireEvent.press(await screen.findByText("Undo")); await waitFor(() => expect(rejectUndo).toBeDefined());
  rerender(<CanonicalApprovalMessage {...props} approval={{ ...view, browserApproval: { ...view.browserApproval } }}/>);
  rejectUndo(new Error("Response lost"));
  await waitFor(() => expect(screen.getByText("Could not undo browser access. Try again.")).toBeTruthy());
  fireEvent.press(screen.getByText("Undo"));
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(2));
});
it("refreshes other native cards after confirmed Undo even when Chat records are unchanged", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  let active: typeof grant | null = grant;
  jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") { active = null; return { ok: true, json: async () => ({ grant: { ...grant, state: "revoked", revision: 2, revokedAt: new Date().toISOString() } }) } as Response; }
    return { ok: true, json: async () => ({ grant: active }) } as Response;
  });
  const lifecycle = { kind: "shared_chrome" as const, leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 as const, expiresAt: new Date(Date.now()+60_000).toISOString() };
  const items = ["first", "second"].map(id => ({ id, role: "system", text: "Use Matrix Browser", toolCalls: [], activities: [], isRunning: false, createdAt: 0,
    approval: { ...approval, approvalId: id, allowedDecisions: [...approval.allowedDecisions], browserApproval: lifecycle } })) as TranscriptMessage[];
  function Cards() {
    const thread = useChatThread({ chatId: props.chatId, detail: null, gatewayUrl: props.gatewayUrl, refresh, optimisticMessages: [] });
    return <>{items.map(thread.renderRequest)}</>;
  }
  render(<Cards/>);
  await waitFor(() => expect(screen.getAllByText("Undo")).toHaveLength(2));
  await act(async () => { fireEvent.press(screen.getAllByText("Undo")[0]!); });
  expect(screen.queryAllByText("Undo")).toHaveLength(0);
});
it("ignores an old decision response after changing Chat", async () => {
  let finish!: (response: Response) => void;
  jest.spyOn(global, "fetch").mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = { ...approval, allowedDecisions: [...approval.allowedDecisions] };
  const { rerender } = render(<CanonicalApprovalMessage {...props} approval={view}/>);
  fireEvent.press(screen.getByText("Allow once")); await waitFor(() => expect(finish).toBeDefined());
  rerender(<CanonicalApprovalMessage {...props} chatId="chat_new" approval={{ ...view, runId: "run_new", approvalId: "approval_new" }}/>);
  await act(async () => { finish({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "approve", submission: "accepted" }) } as Response); });
  expect(screen.getByText("Allow once")).toBeTruthy();
  expect(screen.queryByText("Decision submitted. Waiting for confirmation.")).toBeNull();
});
it("shows a browser decision as submitted while its recorded outcome has not refreshed", async () => {
  jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => ({ ok: true, json: async () => init?.method === "POST"
    ? { approvalId: "approval_test", decision: "approve", submission: "accepted" } : { grant: null } }) as Response);
  refresh.mockRejectedValueOnce(new Error("Refresh unavailable"));
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, actionDigest: "a".repeat(64), allowedDecisions: [...approval.allowedDecisions],
    browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() } }}/>);
  fireEvent.press(screen.getByText("Allow once"));
  await screen.findByText("Decision submitted. Waiting for confirmation.");
  expect(screen.queryByText("Waiting for your approval")).toBeNull();
  expect(screen.queryByText("Allow once")).toBeNull();
});
it.each(["active", "error"])("does not let an earlier %s grant read overwrite confirmed Undo", async outcome => {
  jest.spyOn(console, "warn").mockImplementation(() => {});
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  let finish!: (value: Response) => void; let fail!: (error: Error) => void; let reads = 0;
  jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "DELETE") return { ok: true, json: async () => ({ grant: { ...grant, state: "revoked", revision: 2, revokedAt: new Date().toISOString() } }) } as Response;
    if (++reads === 2) return await new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    return { ok: true, json: async () => ({ grant }) } as Response;
  });
  const view = { ...approval, allowedDecisions: [...approval.allowedDecisions], browserApproval: { kind: "shared_chrome" as const, leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1 as const, expiresAt: new Date(Date.now()+60_000).toISOString() } };
  const { rerender } = render(<CanonicalApprovalMessage {...props} approval={view}/>);
  await screen.findByText("Undo");
  rerender(<CanonicalApprovalMessage {...props} approval={{ ...view, browserApproval: { ...view.browserApproval } }}/>);
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.press(screen.getByText("Undo")); await screen.findByText("Remembered browser access removed");
  await act(async () => { if (outcome === "active") finish({ ok: true, json: async () => ({ grant }) } as Response); else fail(new Error("Old read failed")); });
  expect(screen.getByText("Remembered browser access removed")).toBeTruthy();
  expect(screen.queryByText("Undo")).toBeNull();
  expect(screen.queryByText("Could not check browser access. Refresh this Chat.")).toBeNull();
});

it.each(["modern", "expo-native", "native-minimal"])("loads and decides the exact routine action with %s abort APIs", async mode => {
  // RN abort-controller lacks throwIfAborted. Expo winter patches any/timeout only.
  const descriptors = [
    [AbortSignal, "any"], [AbortSignal, "timeout"], [AbortSignal.prototype, "throwIfAborted"],
  ].map(([object, key]) => ({ object: object as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(object, key as string) }));
  for (const { object, key } of descriptors.filter(({ key }) => mode === "native-minimal" || mode === "expo-native" && key === "throwIfAborted")) Object.defineProperty(object, key, { configurable: true, value: undefined });
  try {
  const id = `rcact_${"a".repeat(32)}`, routine = `rt_${"b".repeat(24)}`;
  const view = { challengeId: id, actionDigest: "d".repeat(64), sourceKind: "chat_run", operation: "pause", status: "pending",
    intent: { operation: "pause", routineId: routine, requestId: "de000000-0000-4000-8000-000000000001", baseRevision: 3 },
    target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Chat chat_test", title: "Allow routine pause?",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." };
  let decided = false;
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    if (init?.method === "POST") decided = true;
    const bytes = new TextEncoder().encode(JSON.stringify(init?.method === "POST" ? { submission: "accepted" } : { ...view, status: decided ? "approved" : "pending" }));
    let sent = false; return { ok: true, headers: new Headers(), body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), releaseLock: () => {}, cancel: async () => {} }) } } as unknown as Response;
  });
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, approvalId: id, actionDigest: view.actionDigest, allowedDecisions: [...approval.allowedDecisions] }}/>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://app.matrix-os.com/vm/pr-1580/api/routine-cli/actions/${id}`);
  expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
  expect(screen.queryByText("Approve for session")).toBeNull();
  fireEvent.press(await screen.findByText("Allow once"));
  await screen.findByText("This operation was allowed");
  expect(screen.queryByText("Needs your approval")).toBeNull();
  const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(post[0]).toBe(`https://app.matrix-os.com/vm/pr-1580/api/routine-cli/actions/${id}/decision`);
  expect(post[1]?.headers).toEqual(expect.objectContaining({ authorization: "Bearer test-token" }));
  expect(JSON.parse(String(post[1]?.body))).toEqual({ actionDigest: view.actionDigest, decision: "approve", clientRequestId: expect.stringMatching(/^req_[a-f0-9]{32}$/) });
  } finally { for (const { object, key, descriptor } of descriptors) { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); } }
});

it.each(["owner", "session", "computer", "unmount"])("actual Native card prevents a token-wait decision after %s changes", async change => {
  const id = `rcact_${"a".repeat(32)}`;
  const view = { challengeId: id, actionDigest: "d".repeat(64), sourceKind: "chat_run", operation: "pause", status: "pending",
    intent: { operation: "pause", routineId: `rt_${"b".repeat(24)}`, requestId: "de000000-0000-4000-8000-000000000001", baseRevision: 3 },
    target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Chat chat_test", title: "Allow routine pause?",
    expiresAt: new Date(Date.now() + 120_000).toISOString(), description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate." };
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(view)); let sent = false;
    return { ok: true, headers: new Headers(), body: { getReader: () => ({ read: async () => sent ? { done: true } : (sent = true, { done: false, value: bytes }), releaseLock: () => {}, cancel: async () => {} }) } } as unknown as Response;
  });
  const renderedApproval = { ...approval, approvalId: id, actionDigest: view.actionDigest, allowedDecisions: [...approval.allowedDecisions] };
  const mounted = render(<CanonicalApprovalMessage {...props} approval={renderedApproval}/>);
  await screen.findByText("Allow once");
  let finish!: (token: string) => void;
  mockRoutineAuth.token = new Promise(resolve => { finish = resolve; });
  fireEvent.press(screen.getByText("Allow once"));
  if (change === "owner") mockRoutineAuth.userId = "owner-b";
  if (change === "session") mockRoutineAuth.sessionId = "session-b";
  mockRoutineAuth.token = null;
  if (change === "unmount") mounted.unmount();
  else mounted.rerender(<CanonicalApprovalMessage {...props} gatewayUrl={change === "computer" ? "https://app.matrix-os.com/vm/other-pc" : props.gatewayUrl} approval={renderedApproval}/>);
  await act(async () => { finish("new-session-token"); await Promise.resolve(); });
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
});

describe("supervised tool approval (Native Mobile)", () => {
  // The exact shape the Claude built-in tool approval control sends: the subject in
  // curly quotes after " · ", and the tool input as JSON after the summary.
  const command = "cd ~/matrix/specs && cat 2692-chat-permission-recovery/spec.md | head -40";
  const input = { command, description: "Review spec scaffolding" };
  const summary = supervisedToolApprovalCopy("Bash").summary;
  const bash = {
    ...approval,
    approvalId: "tool_test",
    title: `Run a command · “${command.slice(0, 80)}”`,
    description: `${summary}\n\n${JSON.stringify(input)}`,
    allowedDecisions: ["approve", "decline", "cancel"] as CanonicalChatApprovalDecision[],
  };
  const accepted = (decision: string) => ({ ok: true, json: async () => ({ approvalId: "tool_test", decision, submission: "accepted" }) } as Response);

  it("shows the request in Desktop's words instead of the raw tool input", () => {
    render(<CanonicalApprovalMessage {...props} approval={bash} />);
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText(`Run a command · ${command}`)).toBeTruthy();
    expect(screen.getByText(command)).toBeTruthy();
    expect(screen.getByText(summary)).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
    expect(screen.queryByText(/"command"/)).toBeNull();
    // Desktop offers no Cancel, and the generic labels are gone.
    for (const label of ["Approve", "Decline", "Cancel"]) expect(screen.queryByText(label)).toBeNull();
  });

  it("opens and closes formatted details from See details", () => {
    render(<CanonicalApprovalMessage {...props} approval={bash} />);
    expect(screen.queryByText("Review spec scaffolding")).toBeNull();
    fireEvent.press(screen.getByText("See details"));
    expect(screen.getByText("Command")).toBeTruthy();
    expect(screen.getAllByText(command)).toHaveLength(2);
    expect(screen.getByText("Description")).toBeTruthy();
    expect(screen.getByText("Review spec scaffolding")).toBeTruthy();
    expect(screen.queryByText(/[{}]/)).toBeNull();
    expect(screen.getByRole("button", { name: "Hide details" }).props.accessibilityState).toMatchObject({ expanded: true });
    fireEvent.press(screen.getByText("Hide details"));
    expect(screen.queryByText("Review spec scaffolding")).toBeNull();
    expect(screen.getByText("See details")).toBeTruthy();
  });

  it.each([["Allow once", "approve"], ["Not now", "decline"]] as const)("%s sends the %s decision Desktop sends", async (label, decision) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(accepted(decision));
    render(<CanonicalApprovalMessage {...props} approval={bash} />);
    fireEvent.press(screen.getByText(label));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://app.matrix-os.com/vm/pr-1580/api/chats/chat_test/runs/run_test/approvals/tool_test");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ decision });
    await screen.findByText("Decision submitted. Waiting for confirmation.");
    expect(screen.queryByText("Allow once")).toBeNull();
    expect(screen.queryByText("Not now")).toBeNull();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("keeps both choices available after a failed decision, without the server's words", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("private upstream token"));
    render(<CanonicalApprovalMessage {...props} approval={bash} />);
    fireEvent.press(screen.getByText("Allow once"));
    await screen.findByText("Could not submit approval. Try again.");
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.getByText("Not now")).toBeTruthy();
    expect(screen.queryByText("private upstream token")).toBeNull();
  });

  it.each([
    [{ decision: "approve" as const }, "Command allowed"],
    [{ decision: "decline" as const }, "Command not allowed"],
    [{ decision: "cancel" as const }, "Command was not used"],
  ])("draws a settled request as one line: %o", (settled, line) => {
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, ...settled, pending: false }} />);
    expect(screen.getByText(line)).toBeTruthy();
    expect(screen.queryByText("Needs your approval")).toBeNull();
    expect(screen.queryByText("Allow once")).toBeNull();
  });

  it("says when a request expired and that nothing ran", () => {
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, pending: false, decision: "cancel", reason: "expired" }} />);
    expect(screen.getByText("Request expired")).toBeTruthy();
    expect(screen.getByText("No answer within 10 minutes, so the command was not run.")).toBeTruthy();
    expect(screen.queryByText("See details")).toBeNull();
    expect(screen.queryByText("Allow once")).toBeNull();
  });

  it("shows the entire safe command title when credential-bearing details are withheld", () => {
    const safeCommand = "printf '%s' 'review every part of this command before approving it' && echo SAFE_END";
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash,
      title: `Run a command · “${safeCommand}”`, description: summary }} />);
    expect(screen.getByRole("header").props.numberOfLines).toBeUndefined();
    expect(screen.getByText(safeCommand)).toBeTruthy();
    expect(screen.queryByText("See details")).toBeNull();
    expect(screen.getByText("Allow once")).toBeTruthy();
  });

  it("keeps every input inspectable when there are more than 24 fields", () => {
    const details = JSON.stringify(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`field_${i}`, `value_${i}`])));
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, description: `${summary}\n\n${details}` }} />);
    fireEvent.press(screen.getByText("See details"));
    expect(screen.getByText(details)).toBeTruthy();
  });

  it("offers no details when the computer withheld them", () => {
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, title: "Run a command", description: summary }} />);
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(screen.queryByText("See details")).toBeNull();
  });

  it("shows details that are not a JSON object as they came", () => {
    const cut = `${JSON.stringify(input).slice(0, 30)}`;
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, description: `${summary}\n\n${cut}` }} />);
    fireEvent.press(screen.getByText("See details"));
    expect(screen.getByText(cut)).toBeTruthy();
  });

  it("keeps a web search query in quotes and plain type", () => {
    const search = supervisedToolApprovalCopy("WebSearch");
    render(<CanonicalApprovalMessage {...props} approval={{ ...bash, title: `${search.title} · “matrix os pricing”`, description: search.summary }} />);
    expect(screen.getByText(`${search.title} · “matrix os pricing”`)).toBeTruthy();
    expect(screen.getByText(search.summary)).toBeTruthy();
  });
});


describe("provider-independent approval presentation", () => {
  it.each(["Run command", "Change files", "Review integration request"])("redesigns %s without relying on Claude title matching", title => {
    const details = JSON.stringify({ command: "curl -sI --max-time 10 https://example.com", timeout: 10000 });
    render(<CanonicalApprovalMessage {...props} approval={{ ...approval, title, description: details,
      allowedDecisions: ["approve", "approve_for_session", "cancel"] }} />);
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByRole("header", { name: title }).props.numberOfLines).toBeUndefined();
    expect(screen.queryByText(details)).toBeNull();
    fireEvent.press(screen.getByText("See details"));
    expect(screen.getByText("curl -sI --max-time 10 https://example.com")).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.getByText("Allow for this session")).toBeTruthy();
    expect(screen.getByText("Cancel request")).toBeTruthy();
    expect(screen.queryByText("Not now")).toBeNull();
  });

  it.each([["Allow once", "approve"], ["Allow for this session", "approve_for_session"], ["Not now", "decline"], ["Cancel request", "cancel"]] as const)("keeps %s bound to %s", async (label, decision) => {
    const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ approvalId: approval.approvalId, decision, submission: "accepted" }) } as Response);
    render(<CanonicalApprovalMessage {...props} approval={{ ...approval, title: "Run command", allowedDecisions: [decision] }} />);
    fireEvent.press(screen.getByRole("button", { name: label }));
    await screen.findByText("Decision submitted. Waiting for confirmation.");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ decision });
  });

  it("removes waiting prose when the server records a generic approval outcome", () => {
    render(<CanonicalApprovalMessage {...props} approval={{ ...approval, title: "Run command", pending: false, decision: "approve", allowedDecisions: ["approve", "cancel"] }} />);
    expect(screen.getByText("Approved")).toBeTruthy();
    expect(screen.queryByText("The agent is waiting for your decision.")).toBeNull();
    expect(screen.queryByText("Needs your approval")).toBeNull();
  });

  it("shows expired generic approvals without inventing a tool timeout", () => {
    render(<CanonicalApprovalMessage {...props} approval={{ ...approval, pending: false, reason: "expired", allowedDecisions: ["approve", "cancel"] }} />);
    expect(screen.getByText("Request expired")).toBeTruthy();
    expect(screen.queryByText("Allow once")).toBeNull();
  });
});
