// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalMcpApprovalsIndicator, ExternalMcpApprovalsPanel } from "../../packages/ui/src/integrations/external-mcp-approvals.js";
import {
  createExternalMcpApprovalsFetchTransport,
  externalMcpApprovalErrorMessage,
  type ExternalMcpApprovalsTransport,
} from "../../packages/ui/src/integrations/external-mcp-approvals-client.js";

const now = Date.parse("2026-11-12T15:00:00.000Z");
const approval = (id: string, overrides: Record<string, unknown> = {}) => ({
  approvalId: id, service: "linear-1a2b3c4d", tool: "create_issue",
  createdAt: new Date(now - 60_000).toISOString(), expiresAt: new Date(now + 9 * 60_000).toISOString(), ...overrides,
});
const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

function fakeTransport(lists: unknown[], decide: ExternalMcpApprovalsTransport["decide"] = async () => ({ status: "approved" })) {
  let index = 0;
  return {
    list: vi.fn(async () => lists[Math.min(index++, lists.length - 1)]),
    decide: vi.fn(decide),
  };
}

beforeEach(() => { vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] }); vi.setSystemTime(now); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("External MCP approvals panel", () => {
  // Fault: a pending external write is invisible, or shows something the contract never promised.
  it("lists each pending write with service, tool, request time, and expiry", async () => {
    const transport = fakeTransport([{ approvals: [approval(A), approval(B, { service: null, tool: "delete_page" })] }]);
    render(<ExternalMcpApprovalsPanel transport={transport} />);
    expect(screen.getByRole("status").textContent).toContain("Loading");
    const list = await screen.findByRole("list", { name: "Pending external MCP approvals" });
    expect(list.textContent).toContain("linear-1a2b3c4d");
    expect(list.textContent).toContain("create_issue");
    expect(list.textContent).toContain("Requested 1 min ago");
    expect(list.textContent).toContain("Expires in 9 min");
    expect(list.textContent).toContain("Unknown service");
  });

  // Fault: the row disappears before the server records the decision, or the wrong decision is sent.
  it("sends the decision and reloads only after the server confirms", async () => {
    const transport = fakeTransport([{ approvals: [approval(A)] }, { approvals: [] }]);
    render(<ExternalMcpApprovalsPanel transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "Decline create_issue on linear-1a2b3c4d" }));
    await waitFor(() => expect(transport.decide).toHaveBeenCalledWith(A, "decline"));
    expect(await screen.findByText("No external writes are waiting")).toBeTruthy();
    expect(transport.list).toHaveBeenCalledTimes(2);
  });

  // Fault: server or provider text from a failed decision reaches the owner, or the row is dropped anyway.
  it("keeps the row and shows allowlisted copy when a decision fails", async () => {
    const transport = fakeTransport([{ approvals: [approval(A)] }],
      async () => { throw Object.assign(new Error("pg: deadlock at /srv/db"), { httpStatus: 409 }); });
    render(<ExternalMcpApprovalsPanel transport={transport} />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve create_issue on linear-1a2b3c4d" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This request expired or was already decided. Refresh to see the current list.");
    expect(screen.getByRole("list", { name: "Pending external MCP approvals" })).toBeTruthy();
    expect(externalMcpApprovalErrorMessage(new Error("Twilio said no"))).toBe("That decision couldn’t be saved. Try again.");
  });

  it("shows an empty state, and a retryable error when the list cannot load or is malformed", async () => {
    const empty = fakeTransport([{ approvals: [] }]);
    render(<ExternalMcpApprovalsPanel transport={empty} />);
    expect(await screen.findByText("No external writes are waiting")).toBeTruthy();
    cleanup();
    const malformed = fakeTransport([{ approvals: [{ ...approval(A), arguments: { secret: "x" } }] }, { approvals: [] }]);
    render(<ExternalMcpApprovalsPanel transport={malformed} />);
    expect((await screen.findByRole("alert")).textContent).toContain("Approvals are unavailable right now.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No external writes are waiting")).toBeTruthy();
  });

  it("disables decisions on an approval that has already expired", async () => {
    render(<ExternalMcpApprovalsPanel transport={fakeTransport([{ approvals: [approval(A, { expiresAt: new Date(now - 1).toISOString() })] }])} />);
    expect((await screen.findByRole("button", { name: "Approve create_issue on linear-1a2b3c4d" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("list", { name: "Pending external MCP approvals" }).textContent).toContain("Expired");
  });
});

describe("External MCP approvals indicator", () => {
  // Fault: the owner never learns a write is waiting, or polling keeps running while the tab is hidden.
  it("appears only while approvals are pending, polls on a bounded interval, and pauses while hidden", async () => {
    const transport = fakeTransport([{ approvals: [] }, { approvals: [approval(A), approval(B)] }, { approvals: [] }]);
    const onOpen = vi.fn();
    render(<ExternalMcpApprovalsIndicator transport={transport} onOpen={onOpen} pollMs={1} />);
    await waitFor(() => expect(transport.list).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => { vi.advanceTimersByTime(15_000); });
    fireEvent.click(await screen.findByRole("button", { name: "2 external MCP writes waiting for approval" }));
    expect(onOpen).toHaveBeenCalled();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(transport.list).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
    expect(transport.list).toHaveBeenCalledTimes(3);
  });
});

describe("External MCP approvals transport", () => {
  // Fault: requests follow redirects, hang, or carry anything beyond the decision.
  it("calls only the two owner routes with deadlines and no redirects", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ approvals: [] }), { headers: { "content-type": "application/json" } }));
    const transport = createExternalMcpApprovalsFetchTransport({ baseUrl: "https://app.matrix-os.test", fetchImpl: fetchImpl as unknown as typeof fetch });
    await transport.list();
    await transport.decide(A, "approve");
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init?.method, init?.body, init?.redirect, init?.signal instanceof AbortSignal])).toEqual([
      ["https://app.matrix-os.test/api/mcp-servers/core/external-approvals", "GET", undefined, "error", true],
      [`https://app.matrix-os.test/api/mcp-servers/core/external-approvals/${A}`, "POST", JSON.stringify({ decision: "approve" }), "error", true],
    ]);
    await expect(transport.decide("../../admin", "approve")).rejects.toThrow();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify({ error: "x" }), { status: 409, headers: { "content-type": "application/json" } }));
    await expect(transport.decide(A, "approve")).rejects.toMatchObject({ httpStatus: 409 });
  });
});
