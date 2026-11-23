// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLogo } from "../../packages/ui/src/agent-logo";

afterEach(cleanup);

describe("AgentLogo", () => {
  it("falls back to the initial when the image fails", () => {
    const { container } = render(<AgentLogo kind="codex" label="Codex" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("C");
  });

  it("shows a later agent's logo after an earlier one failed to load", () => {
    const { container, rerender } = render(<AgentLogo kind="codex" label="Codex" />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<AgentLogo kind="claude" label="Claude" />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("claude.svg");
  });
});
