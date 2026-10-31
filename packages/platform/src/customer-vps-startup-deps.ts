import type { CustomerVpsServiceDeps } from "./customer-vps-types.js";
import { createCustomerVpsSystemStore, createNoopCustomerVpsSystemStore, type CustomerVpsObjectStore } from "./customer-vps-r2.js";

/** Shared startup dependency assembly; each service retains its own context and
 * the source runtime explicitly chooses its private store/credential boundary. */
export function createCustomerVpsStartupDependencies(options: Omit<CustomerVpsServiceDeps, "systemStore"> & {
  objectStore?: CustomerVpsObjectStore;
}): CustomerVpsServiceDeps {
  const { objectStore, ...dependencies } = options;
  return { ...dependencies, systemStore: objectStore
    ? createCustomerVpsSystemStore({ r2: objectStore, r2PrefixRoot: dependencies.config.r2PrefixRoot })
    : createNoopCustomerVpsSystemStore() };
}
