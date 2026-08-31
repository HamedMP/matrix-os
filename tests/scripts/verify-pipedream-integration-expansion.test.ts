import { describe, expect, it } from "vitest";
import type { DiscoveredAction } from "../../packages/gateway/src/integrations/pipedream.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { bindDiscoveredComponentKey } from "../../scripts/lib/pipedream-integration-verification.js";

describe("Pipedream integration expansion verification", () => {
  const discovered: DiscoveredAction[] = [
    { key: "posthog-list-projects", name: "List Projects" },
    { key: "posthog-get-project", name: "Get Project" },
  ];

  it("binds only an exact live-discovered component key for one verification invocation", () => {
    const registryAction = getAction("posthog", "list_projects")!;

    const verifiedAction = bindDiscoveredComponentKey({
      serviceId: "posthog",
      actionId: "list_projects",
      action: registryAction,
      discovered,
      componentKey: "posthog-list-projects",
    });

    expect(verifiedAction).toEqual({
      ...registryAction,
      componentKey: "posthog-list-projects",
    });
    expect(registryAction.componentKey).toBeUndefined();
  });

  it("rejects missing or non-discovered component keys for component-backed actions", () => {
    const action = getAction("posthog", "list_projects")!;

    expect(() => bindDiscoveredComponentKey({
      serviceId: "posthog",
      actionId: "list_projects",
      action,
      discovered,
    })).toThrow("componentKey is required");

    expect(() => bindDiscoveredComponentKey({
      serviceId: "posthog",
      actionId: "list_projects",
      action,
      discovered,
      componentKey: "hand-authored-key",
    })).toThrow("was not returned by live discovery");
  });

  it("leaves reviewed direct API actions unchanged", () => {
    const action = getAction("figma", "get_file")!;
    expect(bindDiscoveredComponentKey({
      serviceId: "figma",
      actionId: "get_file",
      action,
      discovered: [],
    })).toBe(action);
  });
});
