/** Company Brain integration caller: the one way brain source adapters reach the gateway's integration layer. */
export {
  BRAIN_INTEGRATION_CALL_TIMEOUT_MS, BRAIN_INTEGRATION_LABEL_CACHE_MAX, BRAIN_INTEGRATION_LABEL_CACHE_TTL_MS,
  createBrainIntegrationCaller, type BrainIntegrationCallerDeps, type BrainIntegrationRegistry,
} from "./caller.js";
export {
  BRAIN_INTEGRATION_ACCOUNTS_TIMEOUT_MS, BrainIntegrationAccountsError, createBrainIntegrationAccounts,
  type BrainIntegrationAccounts, type BrainIntegrationAccountsDeps,
} from "./accounts.js";
export { createBrainLateBoundIntegrations, type BrainLateBoundIntegrations } from "./late-bound.js";
export { discardBody, readBoundedJson, readJsonField, type BoundedJsonResult } from "./bounded-body.js";
