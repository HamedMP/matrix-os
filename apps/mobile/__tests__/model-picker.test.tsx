import type { ReactElement, ReactNode } from "react";

jest.mock("@expo/ui", () => {
  const React = jest.requireActual("react") as typeof import("react");
  const { Pressable, Text, View } = jest.requireActual("react-native") as typeof import("react-native");
  const Item = () => null;
  const Picker = ({ children, onValueChange, testID }: {
    children: ReactNode;
    onValueChange: (value: string) => void;
    testID?: string;
  }) => React.createElement(View, { testID }, React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return null;
    const item = child as ReactElement<{ label: string; value: string }>;
    return React.createElement(Pressable, {
      accessibilityRole: "button",
      accessibilityLabel: item.props.label,
      onPress: () => onValueChange(item.props.value),
    }, React.createElement(Text, null, item.props.label));
  }));
  Picker.Item = Item;
  return {
    Host: ({ children }: { children: ReactNode }) => React.createElement(View, null, children),
    Picker,
  };
});

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";

import { ModelPicker } from "@/components/ModelPicker";

const supports = {
  rootChat: true,
  resume: true,
  cancellation: true,
  attachments: [],
  tools: [],
  approvals: false,
  userInput: false,
  worktrees: "optional" as const,
  resources: [],
  interactionModes: ["default"],
  permissionModes: ["supervised"],
};

const catalog: CanonicalProviderCatalog = {
  revision: "catalog_mobile_lock",
  drivers: [
    { kind: "pi", displayName: "Pi", adapterVersion: "1", capabilityClass: "coding_agent" },
    { kind: "opencode", displayName: "OpenCode", adapterVersion: "1", capabilityClass: "coding_agent" },
  ],
  instances: [
    {
      id: "pi_default", driverKind: "pi", displayName: "Pi", availability: "available",
      workspaceRequirement: "project_optional", options: [], skills: [], commands: [], setupActions: [], supports,
      models: [
        { id: "anthropic:sonnet", displayName: "Sonnet", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false },
        { id: "anthropic:opus", displayName: "Opus", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false },
      ],
      defaultSelection: { instanceId: "pi_default", model: "anthropic:sonnet" },
      catalogRevision: "catalog_mobile_lock",
    },
    {
      id: "opencode_default", driverKind: "opencode", displayName: "OpenCode", availability: "available",
      workspaceRequirement: "project_optional", options: [], skills: [], commands: [], setupActions: [], supports,
      models: [
        { id: "openai:gpt-5", displayName: "GPT-5", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false },
      ],
      defaultSelection: { instanceId: "opencode_default", model: "openai:gpt-5" },
      catalogRevision: "catalog_mobile_lock",
    },
  ],
};

describe("Native Mobile model picker Provider binding", () => {
  it("keeps all Providers selectable before the first root Turn", () => {
    render(<ModelPicker
      catalog={catalog}
      selection={{ instanceId: "pi_default", model: "anthropic:sonnet" }}
      onSelectionChange={jest.fn()}
    />);

    expect(screen.getByRole("button", { name: "GPT-5" })).toBeTruthy();
    expect(screen.queryByText(/start or fork a new Chat/i)).toBeNull();
  });

  it("hides other Providers after binding while allowing model changes within the bound Provider", () => {
    const onSelectionChange = jest.fn();
    render(<ModelPicker
      catalog={catalog}
      selection={{ instanceId: "pi_default", model: "anthropic:sonnet" }}
      lockedInstanceId="pi_default"
      onSelectionChange={onSelectionChange}
    />);

    expect(screen.queryByRole("button", { name: "GPT-5" })).toBeNull();
    expect(screen.getByText("This Chat is bound to its agent harness. Start or fork a new Chat to use another harness.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Opus" }));
    expect(onSelectionChange).toHaveBeenCalledWith({ instanceId: "pi_default", model: "anthropic:opus" });
  });
});
