// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReviewBar } from "../../../home/apps/_shared/office-ui";

afterEach(cleanup);

function handlers() {
  return {
    onPrevious: vi.fn(),
    onNext: vi.fn(),
    onAccept: vi.fn(),
    onReject: vi.fn(),
    onAcceptAll: vi.fn(),
    onRejectAll: vi.fn(),
  };
}

const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("ReviewBar", () => {
  it("shows a counter and routes every action to its callback", () => {
    const h = handlers();
    render(<ReviewBar total={12} index={2} {...h} />);
    expect(screen.getByRole("toolbar", { name: "Review changes" })).toBeTruthy();
    expect(screen.getByText("3 of 12")).toBeTruthy();
    fireEvent.click(button("Previous change"));
    fireEvent.click(button("Next change"));
    fireEvent.click(button("Accept change"));
    fireEvent.click(button("Reject change"));
    fireEvent.click(button("Accept all"));
    fireEvent.click(button("Reject all"));
    for (const fn of Object.values(h)) expect(fn).toHaveBeenCalledTimes(1);
  });

  it("disables previous at the first change and next at the last", () => {
    const h = handlers();
    const { rerender } = render(<ReviewBar total={3} index={0} {...h} />);
    expect(button("Previous change").disabled).toBe(true);
    expect(button("Next change").disabled).toBe(false);
    rerender(<ReviewBar total={3} index={2} {...h} />);
    expect(button("Previous change").disabled).toBe(false);
    expect(button("Next change").disabled).toBe(true);
  });

  it("disables accept and reject when no change is current but still navigates", () => {
    const h = handlers();
    render(<ReviewBar total={4} index={-1} {...h} />);
    expect(screen.getByText("4 changes")).toBeTruthy();
    expect(button("Accept change").disabled).toBe(true);
    expect(button("Reject change").disabled).toBe(true);
    expect(button("Next change").disabled).toBe(false);
    expect(button("Accept all").disabled).toBe(false);
  });

  it("disables every action when there is nothing to review", () => {
    const h = handlers();
    render(<ReviewBar total={0} index={-1} {...h} />);
    expect(screen.getByText("No changes")).toBeTruthy();
    for (const name of ["Previous change", "Next change", "Accept change", "Reject change", "Accept all", "Reject all"]) {
      expect(button(name).disabled).toBe(true);
    }
  });

  it("uses a custom noun for labels and the counter", () => {
    const h = handlers();
    render(<ReviewBar total={2} index={1} noun="cell change" {...h} />);
    expect(button("Accept cell change")).toBeTruthy();
    expect(screen.getByText("2 of 2")).toBeTruthy();
  });

  it("disables everything while busy", () => {
    const h = handlers();
    render(<ReviewBar total={5} index={1} busy {...h} />);
    fireEvent.click(button("Accept all"));
    expect(h.onAcceptAll).not.toHaveBeenCalled();
  });
});
