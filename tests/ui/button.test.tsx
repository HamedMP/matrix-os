// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Button } from "../../packages/ui/src/Button";

describe("Button", () => {
  it("renders with children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button")).toHaveTextContent("Click me");
  });

  it("applies primary variant by default", () => {
    render(<Button>Primary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("matrix-btn-primary");
  });

  it("applies secondary variant", () => {
    render(<Button variant="secondary">Secondary</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("matrix-btn-secondary");
  });

  it("applies ghost variant", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("matrix-btn-ghost");
  });

  it("applies destructive variant", () => {
    render(<Button variant="destructive">Delete</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("matrix-btn-destructive");
  });

  it("handles click events", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Click</Button>);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("supports disabled state", () => {
    const onClick = vi.fn();
    render(<Button disabled onClick={onClick}>Disabled</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("accepts custom className", () => {
    render(<Button className="custom">Btn</Button>);
    expect(screen.getByRole("button").className).toContain("custom");
  });

  it("accepts custom style", () => {
    render(<Button style={{ marginTop: "10px" }}>Styled</Button>);
    expect(screen.getByRole("button").style.marginTop).toBe("10px");
  });

  it("supports all size variants", () => {
    const sizes = ["sm", "md", "lg", "icon"] as const;
    for (const size of sizes) {
      const { unmount } = render(<Button size={size}>Btn</Button>);
      expect(screen.getByRole("button")).toBeTruthy();
      unmount();
    }
  });
});
