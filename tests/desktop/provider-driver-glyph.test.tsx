// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_AGENT_OPTIONS } from "../../shell/src/components/terminal/terminal-agent-options";
import { ProviderDriverGlyph } from "../../desktop/src/renderer/src/features/chat/ProviderDriverGlyph";
import hermesProviderIcon from "../../desktop/src/renderer/src/assets/providers/hermes-provider.png";

vi.mock("@renderer/lib/hugeicons", () => ({ Cpu: (props: Record<string, unknown>) => <svg {...props} /> }));
afterEach(cleanup);

describe("Desktop Chat provider artwork", () => {
  it.each(["claude", "codex", "opencode", "pi"] as const)("uses shared artwork for %s at the requested size", (id) => {
    const option = TERMINAL_AGENT_OPTIONS.find((candidate) => candidate.id === id);
    if (!option) throw new Error(`Missing Terminal artwork option for ${id}`);
    const kind = id === "claude" ? "claude_code" : id;
    const { container } = render(<ProviderDriverGlyph kind={kind} size={24} />);
    const glyph = container.querySelector(`[data-provider-glyph="${kind}"]`);
    expect(glyph).toHaveStyle({ height: "24px", width: "24px", background: option.color });
    expect(glyph?.querySelector("img")).toHaveAttribute("src", `.${option.logoSrc}`);
    expect(glyph?.querySelector("img")).toHaveAttribute("alt", "");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("renders Hermes as a standalone image at the requested size", () => {
    const { container } = render(<ProviderDriverGlyph kind="hermes" size={20} />);
    const glyph = container.querySelector('[data-provider-glyph="hermes"]');
    expect(glyph).toBeInstanceOf(HTMLImageElement);
    expect(glyph).toHaveAttribute("src", hermesProviderIcon);
    expect(glyph).toHaveAttribute("alt", "");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
    expect(glyph).toHaveAttribute("width", "20");
    expect(glyph).toHaveAttribute("height", "20");
  });

  it("retains OpenClaw and kernel glyph handling", () => {
    const { container } = render(<><ProviderDriverGlyph kind="openclaw" size={20} /><ProviderDriverGlyph kind="kernel" size={20} /></>);
    expect(container.querySelector('[data-provider-glyph="openclaw"]')).toHaveTextContent("🦞");
    expect(container.querySelector('[data-provider-glyph="kernel"] svg')).toHaveAttribute("viewBox", "0 0 510 660");
  });
});
