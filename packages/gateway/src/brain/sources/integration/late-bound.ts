/**
 * The brain's integration seams before platform integrations exist. The owner database (and the brain) starts before
 * the gateway builds its platform database and Pipedream client, so the sources get these forwarding seams at start
 * and the gateway binds the real caller and account lookup once, later. Until then, and after a bind whose deps hold
 * no transport (no internal URL with a machine token, no platform database with a Pipedream client), configured() is
 * false: every call answers unavailable and the integration kinds read not_configured, never not_connected.
 */
import type { BrainIntegrationCaller, BrainIntegrationService } from "../../contracts.js";
import { createBrainIntegrationAccounts, type BrainIntegrationAccounts } from "./accounts.js";
import { createBrainIntegrationCaller, type BrainIntegrationCallerDeps } from "./caller.js";

export interface BrainLateBoundIntegrations extends BrainIntegrationAccounts {
  readonly caller: BrainIntegrationCaller;
  /** Builds the real caller and account lookup from these deps; a second call is a wiring error and throws. */
  bind(deps: BrainIntegrationCallerDeps): void;
}

export function createBrainLateBoundIntegrations(): BrainLateBoundIntegrations {
  let caller: BrainIntegrationCaller | null = null;
  let accounts: BrainIntegrationAccounts | null = null;
  return {
    caller: {
      call: (ownerId, request, signal) => caller === null
        ? Promise.resolve({ status: "unavailable" }) : caller.call(ownerId, request, signal),
    },
    configured: () => accounts !== null && accounts.configured(),
    isConnected: (ownerId: string, service: BrainIntegrationService) =>
      accounts === null ? Promise.resolve(false) : accounts.isConnected(ownerId, service),
    accounts: (ownerId: string, service: BrainIntegrationService) =>
      accounts === null ? Promise.resolve([]) : accounts.accounts(ownerId, service),
    bind(deps) {
      if (caller !== null) throw new Error("Brain integrations are already bound");
      caller = createBrainIntegrationCaller(deps);
      accounts = createBrainIntegrationAccounts(deps);
    },
  };
}
