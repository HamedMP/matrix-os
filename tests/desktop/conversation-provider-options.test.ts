import { describe, expect, it } from "vitest";
import {
  buildConversationProviderOptions,
  type ConversationProviderDefinition,
} from "../../desktop/src/renderer/src/components/conversation/provider-options";

describe("conversation provider option builder", () => {
  it("combines provider definitions with injected runtime readiness", () => {
    const definitions: ConversationProviderDefinition[] = [
      {
        id: "hermes",
        label: "Hermes",
        icon: "hermes",
        capabilities: ["current-conversation", "attachments", "tools"],
      },
      {
        id: "codex",
        label: "Codex",
        icon: "codex",
        capabilities: ["project-conversation", "tools"],
      },
    ];

    expect(buildConversationProviderOptions(definitions, {
      hermes: { state: "ready" },
      codex: { state: "disabled", reason: "Create a project to use Codex." },
    })).toEqual([
      {
        ...definitions[0],
        readiness: { state: "ready" },
      },
      {
        ...definitions[1],
        readiness: { state: "disabled", reason: "Create a project to use Codex." },
      },
    ]);
  });

  it("fails closed when a provider has no injected readiness", () => {
    const definitions: ConversationProviderDefinition[] = [{
      id: "claude",
      label: "Claude",
      icon: "claude",
      capabilities: ["project-conversation", "tools"],
    }];

    expect(buildConversationProviderOptions(definitions, {})).toEqual([{
      ...definitions[0],
      readiness: { state: "disabled", reason: "Provider availability is unknown." },
    }]);
  });
});
