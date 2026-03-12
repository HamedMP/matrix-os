// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Input } from "../../packages/ui/src/Input";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("renders with label", () => {
    render(<Input label="Email" />);
    expect(screen.getByLabelText("Email")).toBeTruthy();
  });

  it("renders error message", () => {
    render(<Input label="Email" error="Required field" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Required field");
  });

  it("sets aria-invalid on error", () => {
    render(<Input label="Email" error="Bad" />);
    expect(screen.getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
  });

  it("does not set aria-invalid without error", () => {
    render(<Input label="Email" />);
    expect(screen.getByRole("textbox")).not.toHaveAttribute("aria-invalid");
  });

  it("handles value changes", () => {
    const onChange = vi.fn();
    render(<Input onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("accepts placeholder", () => {
    render(<Input placeholder="Enter text..." />);
    expect(screen.getByPlaceholderText("Enter text...")).toBeTruthy();
  });

  it("accepts custom className on wrapper", () => {
    const { container } = render(<Input className="custom-wrapper" />);
    expect(container.firstElementChild?.className).toContain("custom-wrapper");
  });

  it("uses provided id", () => {
    render(<Input id="my-input" label="Name" />);
    const input = screen.getByRole("textbox");
    expect(input.id).toBe("my-input");
  });
});
