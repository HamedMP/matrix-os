import { describe, expect, it } from "vitest";
import type { DiscoveredAction } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction } from "../../packages/gateway/src/integrations/types.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { bindDiscoveredComponentKey } from "../../scripts/lib/pipedream-integration-verification.js";

describe("Pipedream integration expansion verification", () => {
  // Catalog actions can migrate to reviewed direct APIs. Keep component
  // discovery coverage independent of any particular service's transport.
  const componentAction: ServiceAction = { description: "List projects", risk: "read", params: {} };
  const discovered: DiscoveredAction[] = [
    { key: "posthog-list-projects", name: "List Projects" },
    { key: "posthog-get-project", name: "Get Project" },
  ];

  it("binds only an exact live-discovered component key for one verification invocation", () => {
    const registryAction = componentAction;

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
    const action = componentAction;

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

  it.each([
    ["figma", "get_file"],
    ["posthog", "list_projects"],
    ["jira", "list_projects"],
  ])("leaves reviewed direct API action %s.%s unchanged", (serviceId, actionId) => {
    const action = getAction(serviceId, actionId)!;
    expect(action.directApi).toBeDefined();
    expect(bindDiscoveredComponentKey({
      serviceId,
      actionId,
      action,
      discovered: [],
      componentKey: "untrusted-component-override",
    })).toBe(action);
  });
});
