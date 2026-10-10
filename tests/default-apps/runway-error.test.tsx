// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Runway } from "../../home/app-templates/connected-starter/src/workflows/TrainingMoneyMeals";
import * as models from "../../home/app-templates/connected-starter/src/workflows/models";
import type { ViewProps } from "../../home/app-templates/connected-starter/src/views/common";

const props = { records: [], onAdd: vi.fn(), onEdit: vi.fn(), onEvidence: vi.fn(), onSave: vi.fn() } as unknown as ViewProps;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("Runway calculation errors", () => {
  it("keeps invalid date guidance separate from unexpected calculation failures", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(<Runway {...props} />);
    fireEvent.change(screen.getByLabelText("Next payday"), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toContain("Choose valid dates");
    expect(log).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("Runway plan failed validation", "RunwayDateError");
  });
  it.each([new Error("private database detail"), "untyped failure"])("logs an unexpected failure without giving date or empty-plan advice", error => {
    vi.spyOn(models, "planRunway").mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Runway {...props} />);
    expect(screen.getByRole("alert").textContent).toBe("Your cash plan could not be calculated. Try again.");
    expect(screen.queryByText(/Add your opening cash/)).toBeNull();
    expect(log).toHaveBeenCalledWith("[runway] cash plan calculation failed", error instanceof Error ? "Error" : "UnknownError");
    expect(document.body.textContent).not.toContain("private database detail");
  });
});
