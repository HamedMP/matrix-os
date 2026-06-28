// @vitest-environment jsdom
import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CtaButton, StatusPill } from "@matrix-os/brand";

describe("@matrix-os/brand primitives", () => {
  it("renders a dark CTA with the deep background", () => {
    render(<CtaButton href="/sign-up">Get started</CtaButton>);
    const link = screen.getByRole("link", { name: /get started/i });
    expect(link.getAttribute("href")).toBe("/sign-up");
    expect(link.getAttribute("style") ?? "").toContain("50, 53, 46");
  });
  it("renders a connected status pill", () => {
    render(<StatusPill tone="connected">Connected</StatusPill>);
    expect(screen.getByText("Connected")).toBeTruthy();
    const pill = screen.getByText("Connected");
    expect(pill.getAttribute("style") ?? "").toContain("67, 78, 63");
  });
});
