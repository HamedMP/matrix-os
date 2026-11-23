// @vitest-environment jsdom
import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DatePicker } from "../../packages/ui/src/date-picker/DatePicker";
import { fromDateKey, toDateKey } from "../../packages/ui/src/date-picker/date-key";

afterEach(cleanup);

describe("date keys", () => {
  it("round-trips a local calendar date without shifting across time zones", () => {
    expect(toDateKey(new Date(2026, 10, 24, 23, 30))).toBe("2026-11-24");
    expect(toDateKey(fromDateKey("2026-01-05")!)).toBe("2026-01-05");
  });

  it("rejects malformed and impossible dates", () => {
    expect(fromDateKey("2026-02-31")).toBeUndefined();
    expect(fromDateKey("24/11/2026")).toBeUndefined();
    expect(fromDateKey(null)).toBeUndefined();
  });
});

function Harness({ initial }: { initial: string | null }) {
  const [value, setValue] = useState<string | null>(initial);
  return <><DatePicker label="Due date" value={value} onChange={setValue} /><output data-testid="value">{value ?? "none"}</output></>;
}

describe("DatePicker", () => {
  it("picks a day from the calendar and clears it again", () => {
    render(<Harness initial="2026-11-10" />);
    fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
    const day = screen.getAllByRole("button").find((button) => button.textContent === "24" && button.closest("[role=grid]"));
    fireEvent.click(day!);
    expect(screen.getByTestId("value").textContent).toBe("2026-11-24");

    fireEvent.click(screen.getByRole("button", { name: /^Due date:/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear date" }));
    expect(screen.getByTestId("value").textContent).toBe("none");
    expect(screen.getByRole("button", { name: "Due date: No date" })).toBeTruthy();
  });
});
