import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";
import { useChatThread } from "@/components/chat/use-chat-thread";
import type { TranscriptMessage } from "@/lib/canonical-chat-transcript";

jest.mock("@clerk/clerk-expo", () => { const getToken = async () => "test-token"; return { useAuth: () => ({ getToken }) }; });
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

afterEach(() => { jest.restoreAllMocks(); refresh.mockClear(); });

it("submits a one-time decision to the selected chat and run, then refreshes", async () => {
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "decline", submission: "accepted" }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Decline"));
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
  fireEvent.press(screen.getByText("Approve"));
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const request = fetchMock.mock.calls[0]?.[1];
  expect(JSON.parse(String(request?.body))).toMatchObject({ actionDigest, decision: "approve" });
});

it("does not render action buttons on a settled approval", () => {
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, pending: false, allowedDecisions: [...approval.allowedDecisions] }} />);
  expect(screen.queryByText("Approve")).toBeNull();
  expect(screen.getByText("Approval ended without a recorded decision")).toBeTruthy();
});

it.each([["approve", "Approved"], ["approve_for_session", "Approved"], ["decline", "Declined"], ["cancel", "Cancelled"]] as const)("renders recorded %s in Native Mobile", (decision, label) => {
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, decision, pending: false, allowedDecisions: [...approval.allowedDecisions] }} />);
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.queryByText("Approve")).toBeNull();
});

it("keeps an accepted submission neutral until the recorded decision arrives", async () => {
  jest.spyOn(global, "fetch").mockResolvedValue({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "approve", submission: "accepted" }) } as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Approve"));
  await waitFor(() => expect(screen.getByText("Decision submitted. Waiting for confirmation.")).toBeTruthy());
  expect(screen.queryByText("Approved")).toBeNull();
});

it("keeps failed submissions recoverable and never displays a raw server error", async () => {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("private upstream token"));
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Cancel"));
  await waitFor(() => expect(screen.getByText("Could not submit approval. Try again.")).toBeTruthy());
  expect(screen.queryByText("private upstream token")).toBeNull();
});

it("recovers authoritative browser access without a recorded grant activity", async () => {
  const grant = { id: "278ca19d-9760-4e67-a221-62bedf393b90", chatId: "chat_test", capability: "shared_chrome", scopeVersion: 1, revision: 1, state: "active", createdAt: new Date().toISOString(), revokedAt: null };
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => ({ ok: true, json: async () => ({ grant: init?.method === "DELETE" ? { ...grant, state: "revoked", revision: 2, revokedAt: new Date().toISOString() } : grant }) }) as Response);
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions], browserApproval: { kind: "shared_chrome", leaseEpoch: "178ca19d-9760-4e67-a221-62bedf393b90", challengeRevision: 0, scopeVersion: 1, expiresAt: new Date(Date.now()+60_000).toISOString() } }} />);
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
  fireEvent.press(screen.getByText("Approve")); await waitFor(() => expect(finish).toBeDefined());
  rerender(<CanonicalApprovalMessage {...props} chatId="chat_new" approval={{ ...view, runId: "run_new", approvalId: "approval_new" }}/>);
  await act(async () => { finish({ ok: true, json: async () => ({ approvalId: "approval_test", decision: "approve", submission: "accepted" }) } as Response); });
  expect(screen.getByText("Approve")).toBeTruthy();
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
