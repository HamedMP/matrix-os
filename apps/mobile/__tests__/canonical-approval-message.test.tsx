import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { CanonicalApprovalMessage } from "@/components/CanonicalApprovalMessage";

jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ getToken: async () => "test-token" }) }));
// Unrelated ESM-only export from the contracts barrel; this suite exercises approval HTTP, not shared HTML.
jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

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

it("does not render action buttons on a settled approval", () => {
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, pending: false, allowedDecisions: [...approval.allowedDecisions] }} />);
  expect(screen.queryByText("Approve")).toBeNull();
  expect(screen.getByText("Resolved")).toBeTruthy();
});

it("keeps failed submissions recoverable and never displays a raw server error", async () => {
  jest.spyOn(global, "fetch").mockRejectedValue(new Error("private upstream token"));
  render(<CanonicalApprovalMessage {...props} approval={{ ...approval, allowedDecisions: [...approval.allowedDecisions] }} />);
  fireEvent.press(screen.getByText("Cancel"));
  await waitFor(() => expect(screen.getByText("Could not submit approval. Try again.")).toBeTruthy());
  expect(screen.queryByText("private upstream token")).toBeNull();
});
