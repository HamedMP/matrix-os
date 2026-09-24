import { appRegistryIncarnation } from "./app-incarnation.js";

type RegisteredApp = { slug: string; created_at: string | Date };
type AppSelection = { ownerId: string; projectId: string | null; appId: string };

/** Resolve a standalone Share selection against the owner's current registry row. */
export function createOwnerAppIncarnationResolver(
  configuredOwnerId: string | undefined,
  registeredApp: (appId: string) => Promise<RegisteredApp | null>,
): (selection: AppSelection) => Promise<string | null> {
  return async ({ ownerId, projectId, appId }) => {
    if (!configuredOwnerId || ownerId !== configuredOwnerId || projectId !== null) return null;
    const record = await registeredApp(appId);
    return record?.slug === appId ? appRegistryIncarnation(record) : null;
  };
}
