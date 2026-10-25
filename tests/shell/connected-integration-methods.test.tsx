// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectedIntegrationAccounts } from "../../shell/src/components/settings/sections/ConnectedIntegrationAccounts.js";

afterEach(cleanup);
const account = (id: string, method?: "matrix" | "pipedream") => ({
  id, service: "gmail", account_label: "Same label", account_email: "same@example.test",
  connected_at: "2026-10-25T00:00:00Z", status: "active", ...(method ? { connection_method: method } : {}),
});
function show(connected: ReturnType<typeof account>[], renamingId: string | null = null) {
  render(<ConnectedIntegrationAccounts connected={connected} available={[{ id: "gmail", name: "Gmail", category: "google" }]}
    renamingId={renamingId} renameDraft="Changed label" savingRename={null} checkingStatus={null} confirmDisconnect={null} disconnecting={null}
    setRenameDraft={vi.fn()} setRenamingId={vi.fn()} setConfirmDisconnect={vi.fn()} handleRename={vi.fn()} handleCheckStatus={vi.fn()} handleDisconnect={vi.fn()} />);
}

describe("connected Gmail method badges", () => {
  it("distinguishes same-email accounts with identical labels", () => {
    show([account("direct", "matrix"), account("external", "pipedream")]);
    expect(screen.getByLabelText("Connection method: Matrix").textContent).toBe("Matrix");
    expect(screen.getByLabelText("Connection method: Pipedream").textContent).toBe("Pipedream");
  });
  it("keeps the method visible for one account while its editable label changes", () => {
    show([account("direct", "matrix")], "direct");
    expect(screen.getByRole("textbox", { name: "Account label" })).toBeTruthy();
    expect(screen.getByLabelText("Connection method: Matrix")).toBeTruthy();
  });
  it("does not guess the method from a legacy account's label", () => {
    show([{ ...account("legacy"), account_label: "Matrix" }]);
    expect(screen.getByLabelText("Connection method: Method unavailable")).toBeTruthy();
    expect(screen.queryByLabelText("Connection method: Matrix")).toBeNull();
  });
});
