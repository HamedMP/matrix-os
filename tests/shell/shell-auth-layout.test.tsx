// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { desktopPalette, fonts } from "@matrix-os/brand";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

describe("ShellAuthLayout", () => {
  afterEach(cleanup);

  it("uses the current brand and keeps the form ahead of supporting copy on narrow screens", () => {
    const { container } = render(
      <ShellAuthLayout eyebrow="Matrix OS" title="Welcome back." body="Your computer is ready.">
        <button>Continue with Google</button>
      </ShellAuthLayout>,
    );
    expect(screen.getByRole("main").style.fontFamily).toBe(fonts.ui);
    expect(screen.getByRole("heading", { level: 1 }).style.fontFamily).toBe(fonts.heading);
    const brandPanel = container.querySelector<HTMLElement>("[data-matrix-auth-brand]");
    expect(brandPanel?.style.backgroundColor).toBe("rgb(14, 52, 34)");
    expect(brandPanel?.style.color).toBe("rgb(252, 252, 248)");
    expect(brandPanel?.querySelector("svg")).not.toBeNull();
    expect(container.querySelector("[data-matrix-auth-form]")?.className).toContain("order-first");
    expect(container.innerHTML).not.toContain("Stripe checkout at launch");
    expect(container.innerHTML).not.toContain("#D06F25");
    expect(desktopPalette.forest).toBe("#0E3422");
  });
  it("owns vertical scrolling within the dynamic viewport", () => {
    const { container } = render(
      <ShellAuthLayout eyebrow="Matrix OS" title="Welcome" body="Sign in to continue.">
        <div>Auth form</div>
      </ShellAuthLayout>,
    );

    const main = screen.getByRole("main");
    const section = container.querySelector("section");

    expect(main.className).toContain("h-dvh");
    expect(main.className).toContain("overflow-x-hidden");
    expect(main.className).toContain("overflow-y-auto");
    expect(section?.className).toContain("min-h-full");
  });
});
