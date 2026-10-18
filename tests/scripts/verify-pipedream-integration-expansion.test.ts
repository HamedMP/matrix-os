import { describe, expect, it } from "vitest";
import type { DiscoveredAction } from "../../packages/gateway/src/integrations/pipedream.js";
import { getAction } from "../../packages/gateway/src/integrations/registry.js";
import { bindDiscoveredComponentKey } from "../../scripts/lib/pipedream-integration-verification.js";

describe("Pipedream integration expansion verification", () => {
  const discovered: DiscoveredAction[] = [
    { key: "jira-list-projects", name: "List Projects" },
    { key: "jira-get-issue", name: "Get Issue" },
  ];

  it("binds only an exact live-discovered component key for one verification invocation", () => {
    const registryAction = getAction("jira", "list_projects")!;
    expect(registryAction.directApi).toBeUndefined();

    const verifiedAction = bindDiscoveredComponentKey({
      serviceId: "jira",
      actionId: "list_projects",
      action: registryAction,
      discovered,
      componentKey: "jira-list-projects",
    });

    expect(verifiedAction).toEqual({
      ...registryAction,
      componentKey: "jira-list-projects",
    });
    expect(registryAction.componentKey).toBeUndefined();
  });

  it("rejects missing or non-discovered component keys for component-backed actions", () => {
    const action = getAction("jira", "list_projects")!;
    expect(action.directApi).toBeUndefined();

    expect(() => bindDiscoveredComponentKey({
      serviceId: "jira",
      actionId: "list_projects",
      action,
      discovered,
    })).toThrow("componentKey is required");

    expect(() => bindDiscoveredComponentKey({
      serviceId: "jira",
      actionId: "list_projects",
      action,
      discovered,
      componentKey: "hand-authored-key",
    })).toThrow("was not returned by live discovery");
  });

  it.each([
    ["figma", "get_file"],
    ["posthog", "list_projects"],
  ])("admits %s/%s without a component key and preserves its direct API identity", (serviceId, actionId) => {
    const action = getAction(serviceId, actionId)!;
    expect(action.directApi?.method).toBe("GET");
    expect(bindDiscoveredComponentKey({
      serviceId,
      actionId,
      action,
      discovered: [],
    })).toBe(action);
  });
});
