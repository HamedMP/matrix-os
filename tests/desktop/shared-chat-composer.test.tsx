// @vitest-environment jsdom

import React, { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
      { kind: "openclaw", displayName: "OpenClaw", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
      { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      { kind: "claude_code", displayName: "Claude Code", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      { kind: "opencode", displayName: "OpenCode", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
      { kind: "pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
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
      {
        id: "opencode_default",
        driverKind: "opencode",
        displayName: "OpenCode",
        availability: "auth_required",
        workspaceRequirement: "project_optional",
        catalogRevision: "catalog_fixture",
        models: [{ id: "provider-default", displayName: "Provider default", availability: "auth_required", capabilities: ["reasoning", "tools"], supportsVision: false, supportsToolUse: true }],
        options: [],
        skills: [],
        commands: [],
        setupActions: [],
        supports: support,
      },
    ],
  };
}

function fixedHermesCatalogFixture(): CanonicalProviderCatalog {
  return {
    revision: "catalog_hermes_fixed",
    drivers: [
      { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
    ],
    instances: [{
      id: "hermes_default",
      driverKind: "hermes",
      displayName: "Hermes",
      availability: "available",
      workspaceRequirement: "none",
      catalogRevision: "catalog_hermes_fixed",
      models: [{
        id: "openai-codex:gpt-5.3-codex-spark",
        displayName: "gpt-5.3-codex-spark",
        availability: "available",
        capabilities: ["tools"],
        supportsVision: false,
        supportsToolUse: true,
      }],
      options: [],
      skills: [],
      commands: [],
      setupActions: [],
      supports: {
        rootChat: true,
        resume: true,
        cancellation: true,
        attachments: ["file"],
        tools: [],
        approvals: false,
        userInput: false,
        worktrees: "none",
        resources: ["file", "folder", "project"],
        interactionModes: ["default"],
        permissionModes: ["supervised"],
      },
      defaultSelection: {
        instanceId: "hermes_default",
        model: "openai-codex:gpt-5.3-codex-spark",
      },
    }],
  };
}

function Harness({
  locked = false,
  onSubmit = vi.fn(),
  resourceSearch,
  menuSide,
}: {
  locked?: boolean;
  onSubmit?: () => void;
  resourceSearch?: (query: string) => Promise<Array<{ kind: "file" | "folder"; id: string; label: string }>>;
  menuSide?: "top" | "bottom";
}) {
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
      resourceSearch={resourceSearch}
      onAttach={() => undefined}
      menuSide={menuSide}
    />
  );
}

describe("SharedChatComposer", () => {
  afterEach(cleanup);

  it("renders the selected model and capability-backed controls in the Figma composer", () => {
    const { container } = render(<Harness />);

    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("GPT-5.6-Sol");
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    expect(screen.getByLabelText("Reasoning")).toBeTruthy();
    expect(screen.queryByLabelText("Interaction mode")).toBeNull();
    expect(screen.getByLabelText("Permission mode")).toBeTruthy();
    expect(container.querySelector(".prompt-card")?.classList.contains("overflow-hidden"))
      .toBe(false);
  });

  it("renders the model picker outside clipping composer containers", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));

    expect(screen.getByRole("listbox", { name: "Models and providers" }).closest(".prompt-card"))
      .toBeNull();
  });

  it("changes effort and permission through in-app menus", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "High" }));
    expect(screen.getByRole("button", { name: "Reasoning" }).textContent).toContain("High");

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "full access" }));
    expect(screen.getByRole("button", { name: "Permission mode" }).textContent).toContain("full access");
  });

  it("opens all Project Chat composer menus below the top composer", () => {
    render(<Harness menuSide="bottom" />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    expect(screen.getByRole("listbox", { name: "Models and providers" })
      .closest('[data-slot="provider-model-picker"]')?.getAttribute("data-preferred-side"))
      .toBe("bottom");
    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));

    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    expect(screen.getByRole("menu", { name: "Reasoning options" }).getAttribute("data-preferred-side"))
      .toBe("bottom");
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));

    fireEvent.click(screen.getByRole("button", { name: "Permission mode" }));
    expect(screen.getByRole("menu", { name: "Permission mode options" }).getAttribute("data-preferred-side"))
      .toBe("bottom");
  });

  it("shows fixed Hermes effort and permission capabilities instead of hiding them", () => {
    const catalog = fixedHermesCatalogFixture();
    const selection = createCanonicalComposerSelection(catalog)!;
    render(
      <SharedChatComposer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        busy={false}
        catalog={catalog}
        selection={selection}
        onSelectionChange={() => undefined}
        instanceLocked={false}
      />,
    );

    const effort = screen.getByRole("button", { name: "Reasoning effort" });
    expect(effort.textContent).toContain("Default");
    expect(effort.hasAttribute("disabled")).toBe(true);
    const permission = screen.getByRole("button", { name: "Permission mode" });
    expect(permission.textContent).toContain("supervised");
    expect(permission.hasAttribute("disabled")).toBe(true);
  });

  it("searches models and switches Provider Instance before the first Turn", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    expect(screen.queryByRole("option", { name: /Claude Opus 4.6/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Claude Code harness, Available" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search models" }), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByRole("option", { name: /Claude Opus 4.6/ }));

    expect(screen.getByRole("button", { name: "Choose model and provider" }).textContent)
      .toContain("Claude Opus 4.6");
    expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
  });

  it("keeps unauthenticated harnesses visible but disabled", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const opencode = screen.getByRole("button", { name: "OpenCode harness, Authentication required" });

    expect(opencode.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(opencode);
    expect(screen.queryByRole("option", { name: /Provider default.*OpenCode/ })).toBeNull();
  });

  it("uses a recognizable product glyph for every Harness rail item", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    const harnesses = [
      ["Hermes harness, Unavailable", "hermes"],
      ["OpenClaw harness, Unavailable", "openclaw"],
      ["Codex harness, Available", "codex"],
      ["Claude Code harness, Available", "claude_code"],
      ["OpenCode harness, Authentication required", "opencode"],
      ["Pi harness, Unavailable", "pi"],
    ] as const;

    for (const [name, kind] of harnesses) {
      expect(screen.getByRole("button", { name }).querySelector(`[data-provider-glyph="${kind}"]`))
        .toBeTruthy();
    }
  });

  it("keeps model selection available but explains the locked Instance", () => {
    render(<Harness locked />);

    fireEvent.click(screen.getByRole("button", { name: "Choose model and provider" }));
    expect(screen.getByText("Provider Instance is locked after the first Turn.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Claude Code harness, Available" }).getAttribute("aria-disabled"))
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

  it("searches workspace files and folders for @ mentions", async () => {
    const resourceSearch = vi.fn(async (query: string) => query === "read"
      ? [{ kind: "file" as const, id: "readme", label: "README.md" }]
      : []);
    render(<Harness resourceSearch={resourceSearch} />);
    const input = screen.getByLabelText("Message chat");

    fireEvent.change(input, { target: { value: "Inspect @read" } });

    await waitFor(() => expect(resourceSearch).toHaveBeenCalledWith("read"));
    fireEvent.click(await screen.findByRole("option", { name: /README.md/ }));
    expect((input as HTMLTextAreaElement).value).toBe("Inspect @README.md ");
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
