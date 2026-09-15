import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Chat Agents motion contract", () => {
  it("uses purposeful composited motion with a reduced-motion fallback", async () => {
    const css = await readFile(new URL("../../packages/ui/src/chat-agents/chat-agents.css", import.meta.url), "utf8");

    expect(css).toContain(".matrix-chat-agents-panel");
    expect(css).toContain("220ms");
    expect(css).toContain("cubic-bezier(0.19, 1, 0.22, 1)");
    expect(css).toContain(".matrix-chat-agent-card:active");
    expect(css).toContain("scale(0.985)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@keyframes matrix-rabbit-wink");
    expect(css).toContain("@keyframes matrix-rabbit-working-ears");
    expect(css).toContain("translateY(-1px) scaleY(0.96)");
    expect(css).toContain("translateY(-4px) scaleY(1.16)");
    expect(css).toContain('[data-rabbit-state="attention"]');
    expect(css).toContain('[data-rabbit-state="working"]');
    expect(css).toContain('[data-rabbit-state="success"]');
    expect(css).toContain('[data-rabbit-state="blocked"]');
    expect(css).toContain(".matrix-agent-rabbit__status");
    expect(css).not.toContain("matrix-rabbit-breathe");
    expect(css).not.toContain("matrix-rabbit-orbit");
    expect(css).toMatch(/prefers-reduced-motion:[\s\S]*\.matrix-recipe-rabbit[\s\S]*animation:\s*none/);
    expect(css).toContain("content-visibility: auto");
    expect(css).toContain("container-type: inline-size");
    expect(css).toContain("@container matrix-agent-recipes (min-width: 720px)");
    expect(css).not.toMatch(/transition:\s*all/);
    expect(css).not.toMatch(/animation[^;]*linear/);
  });
});
