// @vitest-environment jsdom
import React from "react";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { CompactChatProviderChoices } from "../../packages/ui/src/compact-chat-provider-choices.js";
import type { CanonicalProviderChoice } from "../../packages/ui/src/canonical-provider-choice.js";

const matrix: CanonicalProviderChoice = {
  instanceId: "kernel_matrix_included", driverKind: "kernel", harnessLabel: "Matrix AI",
  modelId: "claude-sonnet-5", modelLabel: "Claude Sonnet 5", interactionMode: "default",
  interactionModes: ["default"], permissionMode: "supervised", permissionModes: ["supervised"],
  options: [], selectedOptions: [], supportsFileAttachments: true,
};
const pi = { ...matrix, instanceId: "pi_work", driverKind: "pi" as const, harnessLabel: "Pi · Work" };

describe("compact shared Chat choices", () => {
  it("ships scoped picker colors for both Electron and Web themes", () => {
    render(<CompactChatProviderChoices choices={[matrix]} selected={matrix} onSelect={vi.fn()} />);
    expect(screen.getByRole("searchbox")).toHaveClass("matrix-chat-model-search");
    expect(screen.getByRole("option")).toHaveClass("matrix-chat-model-option");
    const css = readFileSync("packages/ui/src/compact-chat-provider-choices.css", "utf8");
    expect(css).toContain("var(--border-default, var(--border))");
    expect(css).toContain("var(--text-tertiary, var(--muted-foreground))");
    expect(css).toContain("var(--bg-hover, var(--muted))");
    expect(css).toContain(".matrix-chat-model-option:hover:not(:disabled)");
    expect(css).toContain(".matrix-chat-model-option:focus-visible");
  });
  it("shows and searches Pi's server-projected Matrix connection without changing the agent", () => {
    const select = vi.fn();
    const fundedPi = { ...pi, connectionLabel: "Matrix AI" };
    render(<CompactChatProviderChoices choices={[fundedPi]} selected={fundedPi} onSelect={select} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "matrix" } });
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Pi · Work · Matrix AI" }));
    expect(select).toHaveBeenCalledWith(fundedPi);
  });
  it("searches Matrix AI and preserves exact account instance/model selection", () => {
    const select = vi.fn();
    render(<CompactChatProviderChoices choices={[pi, matrix]} selected={pi} onSelect={select} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "matrix" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("option", { name: "Claude Sonnet 5 via Matrix AI" }));
    expect(select).toHaveBeenCalledWith(matrix);
    expect(screen.getByRole("listbox")).toHaveStyle({ maxHeight: "240px", overflowY: "auto" });
  });
  it("keeps another instance locked, including keyboard selection", () => {
    const select = vi.fn();
    render(<CompactChatProviderChoices choices={[pi, matrix]} selected={pi} lockedInstanceId={pi.instanceId} onSelect={select} />);
    expect(screen.getByRole("option", { name: /via Matrix AI/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(screen.getByRole("option", { name: /via Pi/ })).toHaveFocus();
    fireEvent.click(screen.getByRole("option", { name: /via Matrix AI/ }));
    expect(select).not.toHaveBeenCalled();
  });
});
