// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeQueryBodySchema } from "../../packages/gateway/src/app-db-contracts.js";
import App from "../../skills/matrix/collaborative-app-builder/assets/team-tracker/src/App.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// A renderer fixture, not a database or live multi-account qualification.
// Production query schemas reject invented operation shapes at this boundary.
function fixture() {
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
    participant: null, query, mutate,
    onChange: (callback: () => void) => { notify = callback; return unsubscribe; },
  } } });
  return { query, mutate, unsubscribe, externalChange() {
    rows.push({ id: "member", title: "Member task", done: false }); revision = "12"; notify();
  } };
}

describe("collaborative builder's shipped React example", () => {
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
});
