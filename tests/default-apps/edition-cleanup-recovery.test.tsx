// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Edition from "../../home/app-templates/connected-starter/src/edition/Edition";

const plan = {
  id: "existing-plan",
  revision: 0,
  messageIds: ["message-1"],
  expiresAt: "2026-01-01T00:00:00Z",
};
const receipt = {
  id: "existing-operation",
  state: "needs_verification",
  archivedCount: 0,
  restoredCount: 0,
};
afterEach(() => {
  cleanup();
  delete window.MatrixOS;
  vi.restoreAllMocks();
});
it("recovers an uncertain zero-count archive after reopening and verifies its expired submitted plan before undo", async () => {
  let current = receipt;
  const mail = vi.fn(async (action: string) => {
    if (action === "sources") return { sources: [] };
    if (action === "messages") return { messages: [] };
    if (action === "cleanup-recovery")
      return { operations: [{ plan, receipt: current }] };
    if (action === "cleanup-commit")
      return (current = { ...receipt, state: "completed", archivedCount: 1 });
    if (action === "cleanup-undo")
      return (current = {
        ...receipt,
        state: "undone",
        archivedCount: 1,
        restoredCount: 1,
      });
    throw new Error("Unexpected action");
  });
  window.MatrixOS = { mail };
  const view = render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Verify archive outcome" }),
  );
  await waitFor(() =>
    expect(mail).toHaveBeenCalledWith("cleanup-commit", {
      planId: plan.id,
      revision: 0,
    }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  view.unmount();
  render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Undo inbox archive" }),
  );
  await waitFor(() =>
    expect(mail).toHaveBeenCalledWith("cleanup-undo", {
      operationId: receipt.id,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Undo inbox archive" }),
    ).toBeNull(),
  );
});
it("retains partial restoration and allows each recovered operation to be revisited", async () => {
  const mail = vi.fn(async (action: string) => {
    if (action === "sources") return { sources: [] };
    if (action === "messages") return { messages: [] };
    if (action === "cleanup-recovery")
      return {
        operations: [
          {
            plan,
            receipt: { ...receipt, state: "completed", archivedCount: 2 },
          },
          {
            plan: { ...plan, id: "second-plan" },
            receipt: { ...receipt, id: "second-operation" },
          },
        ],
      };
    if (action === "cleanup-undo")
      return {
        ...receipt,
        state: "partial",
        archivedCount: 2,
        restoredCount: 1,
      };
    throw new Error("Unexpected action");
  });
  window.MatrixOS = { mail };
  render(<Edition />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Undo inbox archive" }),
  );
  await waitFor(() =>
    expect(mail).toHaveBeenCalledWith("cleanup-undo", {
      operationId: receipt.id,
    }),
  );
  expect(
    await screen.findByRole("button", { name: "Undo inbox archive" }),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("combobox", { name: "Inbox cleanup history" }),
    { target: { value: "second-operation" } },
  );
  expect(
    await screen.findByRole("button", { name: "Verify archive outcome" }),
  ).toBeTruthy();
});
