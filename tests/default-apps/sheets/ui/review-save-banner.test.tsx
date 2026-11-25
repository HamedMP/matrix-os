// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProposal } from "../../../../home/apps/sheets/src/agent";
import { createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { openSheetSession } from "../../../../home/apps/sheets/src/session";
import { SaveBanner } from "../../../../home/apps/sheets/src/ui/SaveBanner";
import { encode, harness, settle } from "../session/fakes";

afterEach(cleanup);

describe("the save banner for a CSV file with changes waiting for review", () => {
  it("offers Save as .xlsx, which keeps the review and continues in the workbook", async () => {
    const h = harness();
    h.files.put("Data/data.csv", encode("name,amount\nA,10\n"));
    h.files.put("Data/data.xlsx", encode("taken"));
    const session = await openSheetSession(h.deps, "Data/data.csv");
    const sheet = session.getState().activeSheetId;
    runProposal(session, "Raise A", "2026-11-23T10:00:00.000Z", [], (workbook) => workbook.setCell(sheet, { row: 1, col: 1 }, 999));
    h.timers.fire();
    await settle();
    const notify = vi.fn();
    render(<SaveBanner session={session} state={session.getState()} controller={createSheetGridController(session)} notify={notify} />);
    expect(screen.getByRole("alert").textContent).toMatch(/cannot keep the assistant's suggested changes/);
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save as .xlsx" }));
      await settle();
    });
    expect(session.getState()).toMatchObject({ path: "Data/data (2).xlsx", format: "xlsx", saveState: "saved" });
    expect(session.workbook.listChanges()).toHaveLength(1);
    expect(h.files.text("Data/data.csv")).toBe("name,amount\nA,10\n");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("kept for review"), "success");
  });
});
