// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ShellAuthLayout } from "@/components/auth/ShellAuthLayout";

describe("ShellAuthLayout", () => {
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
