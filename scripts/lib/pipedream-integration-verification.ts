import type { DiscoveredAction } from "../../packages/gateway/src/integrations/pipedream.js";
import type { ServiceAction } from "../../packages/gateway/src/integrations/types.js";

interface BindDiscoveredComponentKeyInput {
  serviceId: string;
  actionId: string;
  action: ServiceAction;
  discovered: readonly DiscoveredAction[];
  componentKey?: string;
}

/**
 * Bind a caller-selected component key only after exact live discovery proves
 * that it exists. Direct API actions do not need a Pipedream component.
 */
export function bindDiscoveredComponentKey(
  input: BindDiscoveredComponentKeyInput,
): ServiceAction {
  if (input.action.directApi) return input.action;

  const componentKey = input.componentKey?.trim();
  if (!componentKey) {
    throw new Error(
      `${input.serviceId}/${input.actionId} componentKey is required for live verification`,
    );
  }
  if (!input.discovered.some((candidate) => candidate.key === componentKey)) {
    throw new Error(
      `${input.serviceId}/${input.actionId} componentKey was not returned by live discovery`,
    );
  }

  return { ...input.action, componentKey };
}
