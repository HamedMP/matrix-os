import { describe, expect, it } from "vitest";
import type {
  CanonicalChatSummary,
  CanonicalProviderCatalog,
} from "@matrix-os/contracts";
import {
  changeCanonicalComposerInstance,
  createCanonicalComposerSelection,
  listCanonicalSlashEntries,
  providerInstanceIsLocked,
  updateCanonicalComposerOption,
} from "../../desktop/src/renderer/src/features/chat/canonical-composer-state";

function catalogFixture(): CanonicalProviderCatalog {
  return {
    revision: "catalog_fixture",
    drivers: [
      { kind: "hermes", displayName: "Hermes", adapterVersion: "1.0.0", capabilityClass: "system_agent" },
      { kind: "codex", displayName: "Codex", adapterVersion: "1.0.0", capabilityClass: "coding_agent" },
    ],
    instances: [
      {
        id: "hermes_default",
        driverKind: "hermes",
        displayName: "Hermes",
        availability: "auth_required",
        workspaceRequirement: "none",
        catalogRevision: "catalog_fixture",
        models: [{
          id: "anthropic:claude-opus-4-6",
          displayName: "Claude Opus 4.6",
          availability: "auth_required",
          capabilities: ["reasoning", "tools"],
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
          resources: ["file", "folder"],
          interactionModes: ["default"],
          permissionModes: ["supervised"],
        },
      },
      {
        id: "codex_work",
        driverKind: "codex",
        displayName: "Codex — Work",
        availability: "available",
        workspaceRequirement: "project_optional",
        catalogRevision: "catalog_fixture",
        models: [
          {
            id: "gpt-5.6-sol",
            displayName: "GPT-5.6-Sol",
            availability: "available",
            capabilities: ["reasoning", "tools", "vision"],
            supportsVision: true,
            supportsToolUse: true,
          },
          {
            id: "gpt-5.6-terra",
            displayName: "GPT-5.6-Terra",
            availability: "available",
            capabilities: ["reasoning", "tools"],
            supportsVision: false,
            supportsToolUse: true,
          },
        ],
        options: [
          {
            id: "effort",
            label: "Reasoning",
            kind: "enum",
            values: [
              { value: "low", label: "Low" },
              { value: "high", label: "High" },
            ],
            defaultValue: "low",
            placement: "composer",
          },
          {
            id: "fast",
            label: "Fast service tier",
            kind: "boolean",
            defaultValue: false,
            placement: "advanced",
          },
        ],
        skills: [{ id: "review", displayName: "Review", description: "Review the current changes", invocation: "/review" }],
        commands: [{ id: "status", displayName: "Status", description: "Show repository status", invocation: "/status" }],
        setupActions: [],
        supports: {
          rootChat: true,
          resume: true,
          cancellation: true,
          attachments: ["file", "image"],
          tools: ["read", "write"],
          approvals: true,
          userInput: true,
          worktrees: "optional",
          resources: ["file", "folder", "project", "task", "app", "terminal_session"],
          interactionModes: ["default", "plan"],
          permissionModes: ["supervised", "full_access"],
        },
        defaultSelection: {
          instanceId: "codex_work",
          model: "gpt-5.6-sol",
          options: [{ id: "effort", value: "high" }],
        },
      },
    ],
  };
}

describe("canonical Chat composer state", () => {
  it("chooses the first available Instance and fills capability-backed defaults", () => {
    expect(createCanonicalComposerSelection(catalogFixture())).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.6-sol",
      options: [
        { id: "effort", value: "high" },
        { id: "fast", value: false },
      ],
      interactionMode: "default",
      permissionMode: "supervised",
    });
  });

  it("resets model, options, mode, and permissions when the Instance changes", () => {
    const catalog = catalogFixture();
    const current = createCanonicalComposerSelection(catalog)!;
    const next = changeCanonicalComposerInstance(catalog, current, "hermes_default");

    // An unavailable target is never projected as a valid composer selection.
    expect(next).toBe(current);
  });

  it("updates one provider-specific option without duplicating it", () => {
    const catalog = catalogFixture();
    const current = createCanonicalComposerSelection(catalog)!;

    expect(updateCanonicalComposerOption(catalog, current, "effort", "low").options)
      .toEqual([
        { id: "effort", value: "low" },
        { id: "fast", value: false },
      ]);
  });

  it("combines skills and commands into one slash menu", () => {
    const catalog = catalogFixture();
    expect(listCanonicalSlashEntries(catalog.instances[1]!)).toEqual([
      { id: "review", kind: "skill", displayName: "Review", description: "Review the current changes", invocation: "/review" },
      { id: "status", kind: "command", displayName: "Status", description: "Show repository status", invocation: "/status" },
    ]);
  });

  it("locks only the Provider Instance after the first accepted Turn", () => {
    const chat = {
      providerBinding: {
        driverKind: "codex",
        instanceId: "codex_work",
        lockedAtTurnId: "cturn_first",
      },
    } as CanonicalChatSummary;

    expect(providerInstanceIsLocked(chat)).toBe(true);
    expect(providerInstanceIsLocked(undefined)).toBe(false);
  });
});
