// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import {
  SharedChatComposer,
} from "../../desktop/src/renderer/src/features/chat/SharedChatComposer";
import {
  createCanonicalComposerSelection,
  type CanonicalComposerSelection,
} from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";

function catalogFixture(): CanonicalProviderCatalog {
  const support = {
    rootChat: true,
    resume: true,
    cancellation: true,
    attachments: ["file", "image"] as const,
    tools: ["read", "write"],
    approvals: true,
    userInput: true,
    worktrees: "optional" as const,
    resources: ["file", "folder", "project"] as const,
    interactionModes: ["default", "plan"],
    permissionModes: ["supervised", "full_access"],
  };
  return {
    revision: "catalog_fixture",
    drivers: [
      { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      { kind: "claude_code", displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
    ],
    instances: [
      {
        id: "codex_work",
        driverKind: "codex",
        displayName: "Codex — Work",
        availability: "available",
        workspaceRequirement: "project_optional",
        catalogRevision: "catalog_fixture",
        models: [
          { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", availability: "available", capabilities: ["reasoning", "tools", "vision"], supportsVision: true, supportsToolUse: true },
          { id: "gpt-5.6-terra", displayName: "GPT-5.6-Terra", availability: "available", capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true },
        ],
        options: [{ id: "effort", label: "Reasoning", kind: "enum", values: [{ value: "low", label: "Low" }, { value: "high", label: "High" }], defaultValue: "low", placement: "composer" }],
        skills: [{ id: "review", displayName: "Review", description: "Review the current changes", invocation: "/review" }],
        commands: [{ id: "status", displayName: "Status", description: "Show repository status", invocation: "/status" }],
        setupActions: [],
        supports: support,
        defaultSelection: { instanceId: "codex_work", model: "gpt-5.6-sol", options: [{ id: "effort", value: "low" }] },
      },
      {
        id: "claude_personal",
        driverKind: "claude_code",
        displayName: "Claude — Personal",
        availability: "available",
        workspaceRequirement: "project_optional",
        catalogRevision: "catalog_fixture",
        models: [{ id: "claude-opus-4-6", displayName: "Claude Opus 4.6", availability: "available", capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true }],
        options: [],
        skills: [],
        commands: [],
        setupActions: [],
        supports: { ...support, attachments: [], resources: [] },
        defaultSelection: { instanceId: "claude_personal", model: "claude-opus-4-6" },
      },
    ],
  };
}

function Harness({ locked = false, onSubmit = vi.fn() }: { locked?: boolean; onSubmit?: () => void }) {
  const catalog = catalogFixture();
  const [value, setValue] = useState("");
  const [selection, setSelection] = useState<CanonicalComposerSelection>(
    () => createCanonicalComposerSelection(catalog)!,
  );
  return (
    <SharedChatComposer
      value={value}
      onChange={setValue}
      onSubmit={onSubmit}
      busy={false}
      catalog={catalog}
      selection={selection}
      onSelectionChange={setSelection}
      instanceLocked={locked}
      resources={[
        { kind: "file", id: "src-index", label: "src/index.ts" },
        { kind: "folder", id: "src", label: "src" },
      ]}
      onAttach={() => undefined}
    />
  );
}

describe("SharedChatComposer", () => {
  afterEach(cleanup);

  it("renders the selected model and capability-backed controls in the Figma composer", () => {
    render(<Harness />);

    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("GPT-5.6-Sol");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByLabelText("Reasoning")).toBeTruthy();
    expect(screen.getByLabelText("Interaction mode")).toBeTruthy();
    expect(screen.getByLabelText("Permission mode")).toBeTruthy();
  });

  it("searches models and switches Provider Instance before the first Turn", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 4.6/ }));

    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("Claude Opus 4.6");
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
  });

  it("keeps model selection available but explains the locked Instance", () => {
    render(<Harness locked />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    expect(screen.getByText("Provider Instance is locked after the first Turn.")).toBeTruthy();
    expect(screen.getByRole("option", { name: /Claude Opus 4.6/ }).getAttribute("aria-disabled"))
      .toBe("true");
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.6-Terra/ }));
    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("GPT-5.6-Terra");
  });

  it("opens one slash menu for skills and commands and inserts the invocation", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Message chat");

    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Skills and commands" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /Review/ }));
    expect((input as HTMLTextAreaElement).value).toBe("/review ");
  });

  it("opens the resource menu for @ and submits with Enter", () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    const input = screen.getByLabelText("Message chat");

    fireEvent.change(input, { target: { value: "Inspect @ind" } });
    expect(screen.getByRole("listbox", { name: "Resources" })).toBeTruthy();
    fireEvent.click(screen.getByRole("option", { name: /src\/index.ts/ }));
    expect((input as HTMLTextAreaElement).value).toBe("Inspect @src/index.ts ");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("navigates slash suggestions with arrows and Enter", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Message chat");

    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect((input as HTMLTextAreaElement).value).toBe("/status ");
  });

  it("navigates the model picker from its search field", () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const search = screen.getByRole("searchbox", { name: "Search models" });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /GPT-5.6-Sol/ }));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("option", { name: /GPT-5.6-Terra/ }));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });

    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("GPT-5.6-Terra");
  });
});
