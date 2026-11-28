// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SheetGrid, createSheetGridController } from "../../../../home/apps/sheets/src/grid";
import { SheetReviewController } from "../../../../home/apps/sheets/src/review";
import { MARKUP_ATTRIBUTE, SheetReviewPanel, applyMarkup } from "../../../../home/apps/sheets/src/ui/review";
import { FakeGrid, openModel, proposeOnModel } from "./fixture";

afterEach(cleanup);

describe("SheetReviewPanel", () => {
  it("lists changes by proposal with old and new values and formulas", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const review = new SheetReviewController(model.session, new FakeGrid());
    render(<SheetReviewPanel review={review} gridElement={null} />);

    const assistant = screen.getByRole("region", { name: "Link the total revenue by Matrix Assistant" });
    const rows = within(assistant).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[1]!.textContent).toContain("Summary");
    expect(rows[1]!.textContent).toContain("B2");
    expect(rows[1]!.querySelector("del")?.textContent).toBe("725,000");
    expect(rows[1]!.querySelector("ins")?.textContent).toBe("795,856=Projection!N4");
    expect(screen.getByRole("region", { name: "Higher costs by Alex" })).toBeTruthy();
    expect(screen.getByRole("toolbar", { name: "Review cell changes" }).textContent).toContain("3 cell changes");
    review.dispose();
  });

  it("steps with the review bar and accepts or rejects the current change", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const grid = new FakeGrid();
    const review = new SheetReviewController(model.session, grid);
    render(<SheetReviewPanel review={review} gridElement={null} />);

    fireEvent.click(screen.getByRole("button", { name: "Next cell change" }));
    expect(screen.getByRole("toolbar", { name: "Review cell changes" }).textContent).toContain("1 of 3");
    expect(grid.selected).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reject cell change" }));
    expect(model.session.cell(model.sheets.assumptions, 2, 1).value).toBe(0.03);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Accept change at Assumptions!B5" }));
    expect(model.session.cell(model.sheets.assumptions, 4, 1).value).toBe(20000);
    expect(screen.getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Accept all" }));
    expect(screen.getByText("No changes to review")).toBeTruthy();
    review.dispose();
  });

  it("accepts a selection of changes", async () => {
    const model = await openModel();
    proposeOnModel(model);
    const review = new SheetReviewController(model.session, null);
    render(<SheetReviewPanel review={review} gridElement={null} />);
    fireEvent.click(screen.getByLabelText("Select change at Assumptions!B3"));
    fireEvent.click(screen.getByLabelText("Select change at Assumptions!B5"));
    expect(screen.getByText("2 changes selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reject selected" }));
    expect(model.session.cell(model.sheets.assumptions, 2, 1).value).toBe(0.03);
    expect(model.session.cell(model.sheets.assumptions, 4, 1).value).toBe(18000);
    expect(review.getState().items.map((item) => item.location)).toEqual(["Summary!B2"]);
    review.dispose();
  });

  it("draws old values struck through on the real grid while markup is on", async () => {
    const model = await openModel();
    proposeOnModel(model);
    model.session.setActiveSheet(model.sheets.summary);
    const controller = createSheetGridController(model.session);
    const review = new SheetReviewController(model.session, controller);
    const view = render(
      <div>
        <div style={{ height: 400 }}>
          <SheetGrid session={model.session} controller={controller} />
        </div>
        <SheetReviewPanel review={review} />
      </div>,
    );
    const gridRoot = view.container.querySelector<HTMLElement>(".sheet-grid")!;
    const changed = () => gridRoot.querySelector<HTMLElement>("[data-row='1'][data-col='1']")!;
    expect(changed().getAttribute("data-change-id")).not.toBeNull();
    expect(changed().hasAttribute(MARKUP_ATTRIBUTE)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Markup" }));
    expect(screen.getByRole("button", { name: "Markup" }).getAttribute("aria-pressed")).toBe("true");
    expect(changed().getAttribute(MARKUP_ATTRIBUTE)).toBe("725,000");
    expect(gridRoot.classList.contains("sheets-markup")).toBe(true);
    expect(changed().getAttribute("aria-description")).toContain("was 725,000, now 795,856");

    await act(async () => {
      review.reject("all");
    });
    expect(changed().hasAttribute(MARKUP_ATTRIBUTE)).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Markup" }));
    expect(gridRoot.classList.contains("sheets-markup")).toBe(false);
    review.dispose();
    controller.dispose();
  });

  it("applyMarkup sets and clears the attribute by change id", () => {
    const root = document.createElement("div");
    root.innerHTML = `<div data-change-id="c1"></div><div data-change-id="c2"></div><div></div>`;
    expect(applyMarkup(root, new Map([["c1", "old"]]))).toBe(1);
    expect(root.children[0]!.getAttribute(MARKUP_ATTRIBUTE)).toBe("old");
    expect(root.children[1]!.hasAttribute(MARKUP_ATTRIBUTE)).toBe(false);
    expect(applyMarkup(root, null)).toBe(0);
    expect(root.querySelector(`[${MARKUP_ATTRIBUTE}]`)).toBeNull();
  });
});
