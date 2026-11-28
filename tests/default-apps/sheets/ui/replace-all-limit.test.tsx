// @vitest-environment jsdom
/**
 * Replace all changes every match or none. When the search stopped at its
 * limit, the matches past it are unknown: replacing only the first part and
 * saying "Replaced" would leave old values the owner believes are gone.
 */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_MATCHES } from "../../../../home/apps/sheets/src/ui/find-replace";
import { flush, renderWithWorkbook } from "./harness";

afterEach(cleanup);

function toastTitles(): string[] {
  return Array.from(document.querySelectorAll(".oui-toast__title")).map((node) => node.textContent ?? "");
}

describe("Replace all past the search limit", () => {
  // Fault: Replace all ignored a truncated search, changed the first 10,000 matches and reported success.
  it("refuses, changes nothing and says why", async () => {
    const total = MAX_MATCHES + 1;
    const app = await renderWithWorkbook("Big.xlsx", (workbook, sheet) => {
      workbook.setRange(
        sheet,
        { row: 0, col: 0 },
        Array.from({ length: total }, () => ["apple"]),
      );
    });
    const session = app.session();
    const sheet = session.getState().activeSheetId;
    fireEvent.keyDown(window, { key: "h", ctrlKey: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Find" }), { target: { value: "apple" } });
    fireEvent.change(screen.getByLabelText("Replace with"), { target: { value: "pear" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace all" }));
    await flush();

    expect(session.cell(sheet, 0, 0).value).toBe("apple");
    expect(session.cell(sheet, total - 1, 0).value).toBe("apple");
    expect(session.getState().dirty).toBe(false);
    const titles = toastTitles();
    expect(titles.some((title) => title.startsWith("Replaced"))).toBe(false);
    expect(titles.some((title) => title.includes("nothing was replaced"))).toBe(true);
  }, 60_000);
});
