// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts.js";
import App from "../../skills/matrix/collaborative-app-builder/assets/team-tracker/src/App.js";
import { createOwnerCollaborativeAppTransport } from "../../shell/src/lib/owner-collaborative-app-transport.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// A renderer fixture, not a database or live multi-account qualification.
// Production query schemas reject invented operation shapes at this boundary.
function fixture(retryMutation?: () => Promise<unknown>) {
  let rows = [{ id: "existing", title: "Existing owner task", done: false }];
  let revision = "7";
  let notify = () => {};
  const unsubscribe = vi.fn();
  const query = vi.fn(async (action) => {
    BridgeQueryBodySchema.parse({ ...action, app: "team-tracker" });
    return { result: structuredClone(action.action === "findOne" ? rows.find((row) => row.id === action.id) ?? null : rows), revision };
  });
  const mutate = vi.fn(async (action, expectedRevision) => {
    const parsed = BridgeQueryBodySchema.parse({ ...action, app: "team-tracker" });
    expect(expectedRevision).toBe(revision);
    if (parsed.action === "insert") rows.push(parsed.data as typeof rows[number]);
    else if (parsed.action === "update") rows = rows.map((r) => r.id === parsed.id ? { ...r, ...parsed.data } : r);
    else if (parsed.action === "delete") rows = rows.filter((r) => r.id !== parsed.id);
    revision = String(Number(revision) + 1);
    return { result: null, revision, replayed: false };
  });
  Object.defineProperty(window, "MatrixOS", { configurable: true, value: { collaboration: {
    participant: null, query, mutate, retryMutation,
    onChange: (callback: () => void) => { notify = callback; return unsubscribe; },
  } } });
  return { query, mutate, unsubscribe, externalChange() {
    rows = [...rows.filter((row) => row.id !== "member"), { id: "member", title: "Member task", done: false }]; revision = "12"; notify();
  } };
}

describe("collaborative builder's shipped React example", () => {
  it("keeps a signal-confirmed save successful when its response later fails", async () => {
    const bridge = fixture(); const send = bridge.mutate.getMockImplementation()!; let rejectResponse!: () => void;
    bridge.mutate.mockImplementationOnce(async (action, revision) => {
      await send(action, revision); bridge.externalChange();
      return new Promise((_resolve, reject) => { rejectResponse = () => reject(new Error("late lost response")); });
    });
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Already confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("checkbox", { name: "Complete Already confirmed" });
    await waitFor(() => expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe(""));
    await act(async () => rejectResponse());
    expect(screen.queryByRole("alert")).toBeNull(); expect(bridge.mutate).toHaveBeenCalledOnce();
  });

  it("keeps a signal-confirmed retry successful when its response later fails", async () => {
    let rejectResponse!: () => void; let action!: Record<string, unknown>; let revision!: string;
    const retry = vi.fn(async () => {
      await send(action, revision); bridge.externalChange();
      return new Promise((_resolve, reject) => { rejectResponse = () => reject(new Error("late response")); });
    });
    const bridge = fixture(retry); const send = bridge.mutate.getMockImplementation()!;
    bridge.mutate.mockImplementationOnce(async (value, base) => { action = value; revision = base; throw new Error("offline"); });
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Retried and confirmed" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" })); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    await screen.findByRole("checkbox", { name: "Complete Retried and confirmed" });
    await waitFor(() => expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe(""));
    await act(async () => rejectResponse());
    expect(screen.queryByRole("alert")).toBeNull(); expect(bridge.mutate).toHaveBeenCalledOnce();
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([new Error("offline"), "offline"])("retains the draft when retrying the original operation fails: %s", async (failure) => {
    const retry = vi.fn().mockRejectedValue(failure); const bridge = fixture(retry);
    bridge.mutate.mockRejectedValueOnce(new Error("offline"));
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Retained" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    await screen.findByText("Save still not confirmed. Your input is retained. Review saved records before making another change.");
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Retained");
    expect(retry).toHaveBeenCalledOnce(); expect(bridge.mutate).toHaveBeenCalledOnce();
  });

  it.each([false, true])("cleans up while an original-operation retry settles (rejected: %s)", async (reject) => {
    let settle!: () => void;
    const retry = vi.fn(() => new Promise((resolve, fail) => { settle = () => reject ? fail(new Error("offline")) : resolve({ result: null, revision: "8" }); }));
    const bridge = fixture(retry); bridge.mutate.mockRejectedValueOnce(new Error("offline"));
    const view = render(<App />); await screen.findByText("Existing owner task");
    fireEvent.click(screen.getByRole("checkbox")); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
    expect((screen.getByRole("button", { name: "Retry original save" }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount(); await act(async () => settle());
    expect(bridge.unsubscribe).toHaveBeenCalledOnce(); expect(bridge.query).toHaveBeenCalledTimes(1);
    expect(bridge.mutate).toHaveBeenCalledOnce();
  });

  it("serializes rapid write and retry gestures before React commits disabled controls", async () => {
    let failWrite!: () => void; let failRetry!: () => void;
    const retry = vi.fn(() => new Promise((_resolve, reject) => { failRetry = () => reject(new Error("offline")); }));
    const bridge = fixture(retry);
    bridge.mutate.mockImplementationOnce(() => new Promise((_resolve, reject) => { failWrite = () => reject(new Error("offline")); }));
    render(<App />); await screen.findByText("Existing owner task");
    const toggle = screen.getByRole("checkbox"); const remove = screen.getByRole("button", { name: "Delete Existing owner task" });
    act(() => { fireEvent.click(toggle); fireEvent.click(remove); });
    expect(bridge.mutate).toHaveBeenCalledOnce(); await act(async () => failWrite());
    const recovery = screen.getByRole("button", { name: "Retry original save" });
    act(() => { fireEvent.click(recovery); fireEvent.click(recovery); });
    expect(retry).toHaveBeenCalledOnce(); await act(async () => failRetry());
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("retries an owner's undelivered save through the real transport with the original operation ID", async () => {
    const bridge = fixture(); const scopeId = "10000000-0000-4000-8000-000000000001";
    const requestId = vi.fn(() => "20000000-0000-4000-8000-000000000001");
    const requests: unknown[] = [];
    const request = vi.fn(async (_scope: string, _method: string, path: string, raw: unknown) => {
      const body = raw as { action: Record<string, unknown>; expectedRevision: string };
      if (path.endsWith("/view")) return bridge.query(body.action);
      requests.push(structuredClone(raw));
      if (requests.length === 1) throw new Error("Connection lost before delivery");
      const reply = await bridge.mutate(body.action, body.expectedRevision);
      return { ...reply, revision: Number(reply.revision) };
    });
    const transport = createOwnerCollaborativeAppTransport({
      appId: "team-tracker", createRequestId: requestId, legacyRequest: vi.fn(), onChanged: vi.fn(),
      api: { direct: { request, subscribeEvents: vi.fn(() => vi.fn()) }, get: vi.fn(async () => ({
        scopeId, organizationId: "org_team", owner: { actorId: "user_owner", displayName: "Owner" },
        build: { appId: "team-tracker", catalogId: "30000000-0000-4000-8000-000000000001", registrationIncarnation: "a".repeat(64),
          manifestVersion: "1.0.0", buildId: "b".repeat(64), manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
          bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1" },
        readinessId: "40000000-0000-4000-8000-000000000001", state: "active", shareRevision: "1", bindingRevision: "1", dataRevision: "7",
        createdAt: "2026-11-09T00:00:00.000Z", updatedAt: "2026-11-09T00:00:00.000Z",
      })) },
    });
    Object.defineProperty(window, "MatrixOS", { configurable: true, value: { collaboration: {
      participant: null, query: transport.query, mutate: transport.mutate, retryMutation: transport.retryMutation,
      onChange: () => bridge.unsubscribe,
    } } });
    try {
      render(<App />); await screen.findByText("Existing owner task");
      fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Recover me" } });
      fireEvent.click(screen.getByRole("button", { name: "Add task" }));
      await screen.findByRole("alert");
      expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Recover me");
      fireEvent.click(screen.getByRole("button", { name: "Retry original save" }));
      await screen.findByRole("checkbox", { name: "Complete Recover me" });
      await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
      expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
      expect(requestId).toHaveBeenCalledOnce(); expect(bridge.mutate).toHaveBeenCalledOnce();
      expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("");
    } finally { transport.close(); }
  });

  it("preserves existing records, creates, edits, deletes and reopens authoritative data", async () => {
    const bridge = fixture();
    const view = render(<App />);
    await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "New task" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("checkbox", { name: "Complete New task" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Complete New task" }));
    await waitFor(() => expect((screen.getByRole("checkbox", { name: "Complete New task" }) as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "Delete New task" }));
    await waitFor(() => expect(screen.queryByRole("checkbox", { name: "Complete New task" })).toBeNull());
    view.unmount();
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
    render(<App />);
    await screen.findByText("Existing owner task");
    expect(screen.queryByRole("checkbox", { name: "Complete New task" })).toBeNull();
  });

  it("rereads a member change while retaining the owner's unfinished draft", async () => {
    const bridge = fixture(); render(<App />);
    await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Unfinished" } });
    await act(async () => bridge.externalChange());
    await screen.findByText("Member task");
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Unfinished");
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByText("Unfinished");
    expect(bridge.mutate.mock.calls[0]![1]).toBe("12");
  });

  it.each(["conflict", "response lost", "host offline"])("keeps input on %s without issuing another mutation", async (reason) => {
    const bridge = fixture(); render(<App />);
    await screen.findByText("Existing owner task");
    bridge.mutate.mockRejectedValueOnce(new Error(reason));
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Keep this draft");
    expect((screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await waitFor(() => expect(bridge.query.mock.calls.length).toBeGreaterThan(1));
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Existing owner task")).toBeTruthy();
  });

  it("shows unavailable storage rather than a successful empty app", async () => {
    fixture(); Object.defineProperty(window, "MatrixOS", { configurable: true, value: undefined });
    render(<App />);
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("recovers from a non-Error transport rejection and ignores empty submissions", async () => {
    const bridge = fixture(); bridge.query.mockRejectedValueOnce("offline");
    render(<App />); await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "   " } });
    fireEvent.submit(screen.getByLabelText("New task").closest("form")!);
    expect(bridge.mutate).not.toHaveBeenCalled();
  });

  it("confirms a committed response-lost insert by its saved ID without duplicating it", async () => {
    const bridge = fixture();
    const send = bridge.mutate.getMockImplementation()!;
    bridge.mutate.mockImplementationOnce(async (action, revision) => { await send(action, revision); throw new Error("response lost"); });
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Saved once" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await screen.findByRole("checkbox", { name: "Complete Saved once" });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("");
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { result: [{ id: "bad", title: "Invalid", done: "false" }], revision: "7" },
    { result: [], revision: "invalid" },
    { result: null, revision: "7" },
  ])("rejects malformed authoritative data without enabling writes", async (reply) => {
    const bridge = fixture(); bridge.query.mockResolvedValueOnce(reply as never);
    render(<App />);
    await screen.findByRole("alert");
    expect(screen.queryByText("No saved tasks yet.")).toBeNull();
    expect((screen.getByRole("button", { name: "Add task" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await screen.findByText("Existing owner task");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("discards only a deliberately abandoned draft and keeps saved records", async () => {
    const bridge = fixture(); render(<App />); await screen.findByText("Existing owner task");
    bridge.mutate.mockRejectedValueOnce("offline");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Abandoned" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Discard local draft" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Existing owner task")).toBeTruthy();
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it.each(["update", "delete"])("confirms an uncertain %s through an exact-ID reread", async (operation) => {
    const bridge = fixture(); const send = bridge.mutate.getMockImplementation()!;
    bridge.mutate.mockImplementationOnce(async (action, revision) => { await send(action, revision); throw new Error("lost"); });
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.click(operation === "update"
      ? screen.getByRole("checkbox", { name: "Complete Existing owner task" })
      : screen.getByRole("button", { name: "Delete Existing owner task" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(bridge.query).toHaveBeenCalledWith({ action: "findOne", table: "tasks", id: "existing" });
    if (operation === "update") expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
    else expect(screen.getByText("No saved tasks yet.")).toBeTruthy();
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it("does not mistake a row outside the list page for a confirmed deletion", async () => {
    const bridge = fixture(); render(<App />); await screen.findByText("Existing owner task");
    bridge.mutate.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Existing owner task" }));
    await screen.findByRole("alert");
    bridge.query.mockResolvedValueOnce({ result: [], revision: "7" });
    fireEvent.click(screen.getByRole("button", { name: "Review saved records" }));
    await waitFor(() => expect(bridge.query).toHaveBeenCalledWith({ action: "findOne", table: "tasks", id: "existing" }));
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(bridge.mutate).toHaveBeenCalledTimes(1);
  });

  it("retains newer input when an earlier save finishes and ignores stale reads", async () => {
    const bridge = fixture(); const send = bridge.mutate.getMockImplementation()!;
    let complete!: () => void;
    bridge.mutate.mockImplementationOnce(async (action, revision) => { await new Promise<void>((resolve) => { complete = resolve; }); return send(action, revision); });
    render(<App />); await screen.findByText("Existing owner task");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "First" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Next draft" } });
    await act(async () => complete());
    await screen.findByText("First");
    expect((screen.getByLabelText("New task") as HTMLInputElement).value).toBe("Next draft");
    let finishRead!: (value: { result: never[]; revision: string }) => void;
    bridge.query.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
    await act(async () => bridge.externalChange());
    await act(async () => bridge.externalChange());
    await screen.findAllByText("Member task");
    await act(async () => finishRead({ result: [], revision: "1" }));
    expect(screen.getByText("First")).toBeTruthy();
  });

  it.each([false, true])("cleans up while an in-flight write settles (rejected: %s)", async (reject) => {
    const bridge = fixture(); let settle!: () => void;
    bridge.mutate.mockImplementationOnce(() => new Promise((resolve, fail) => { settle = () => reject ? fail("offline") : resolve({ result: null, revision: "8", replayed: false }); }));
    const view = render(<App />); await screen.findByText("Existing owner task");
    fireEvent.click(screen.getByRole("checkbox")); view.unmount();
    await act(async () => settle());
    expect(bridge.unsubscribe).toHaveBeenCalledOnce();
    expect(bridge.query).toHaveBeenCalledTimes(1);
  });
});
