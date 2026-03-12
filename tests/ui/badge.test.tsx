// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Badge } from "../../packages/ui/src/Badge";

describe("Badge", () => {
  it("renders children", () => {
    render(<Badge>Active</Badge>);
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("applies default variant", () => {
    render(<Badge>Default</Badge>);
    expect(screen.getByText("Default").className).toContain("matrix-badge-default");
  });

  it("applies success variant", () => {
    render(<Badge variant="success">Online</Badge>);
    expect(screen.getByText("Online").className).toContain("matrix-badge-success");
  });

  it("applies warning variant", () => {
    render(<Badge variant="warning">Pending</Badge>);
    expect(screen.getByText("Pending").className).toContain("matrix-badge-warning");
  });

  it("applies error variant", () => {
    render(<Badge variant="error">Failed</Badge>);
    expect(screen.getByText("Failed").className).toContain("matrix-badge-error");
  });

  it("accepts custom className", () => {
    render(<Badge className="extra">Tag</Badge>);
    expect(screen.getByText("Tag").className).toContain("extra");
  });

  it("accepts custom style", () => {
    render(<Badge style={{ fontSize: "16px" }}>Big</Badge>);
    expect(screen.getByText("Big").style.fontSize).toBe("16px");
  });
});
