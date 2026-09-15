// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_AGENT_OPTIONS } from "../../shell/src/components/terminal/terminal-agent-options";
import { ProviderDriverGlyph } from "../../desktop/src/renderer/src/features/chat/ProviderDriverGlyph";

vi.mock("@renderer/lib/hugeicons", () => ({ Cpu: (props: Record<string, unknown>) => <svg {...props} /> }));
afterEach(cleanup);

describe("Desktop Chat provider artwork", () => {
  it.each(TERMINAL_AGENT_OPTIONS)("uses canonical $id artwork at the requested size", (option) => {
    const kind = option.id === "claude" ? "claude_code" : option.id;
    const { container } = render(<ProviderDriverGlyph kind={kind} size={24} />);
    const glyph = container.querySelector(`[data-provider-glyph="${kind}"]`);
    expect(glyph).toHaveStyle({ height: "24px", width: "24px", background: option.color });
    expect(glyph?.querySelector("img")).toHaveAttribute("src", option.logoSrc);
    expect(glyph?.querySelector("img")).toHaveAttribute("alt", "");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("retains Hermes, OpenClaw, and kernel glyph handling", () => {
    const { container } = render(<><ProviderDriverGlyph kind="hermes" size={20} /><ProviderDriverGlyph kind="openclaw" size={20} /><ProviderDriverGlyph kind="kernel" size={20} /></>);
    expect(container.querySelector('[data-provider-glyph="hermes"]')).toHaveAttribute("src", expect.stringContaining("hermes-provider.png"));
    expect(container.querySelector('[data-provider-glyph="openclaw"]')).toHaveTextContent("🦞");
    expect(container.querySelector('svg[data-provider-glyph="kernel"]')).toBeInTheDocument();
  });
});
