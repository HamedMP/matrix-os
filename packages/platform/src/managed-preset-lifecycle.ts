import { MANAGED_INTEGRATIONS } from "@matrix-os/contracts/managed-integrations";

interface SelectedPreset { id: string; user_id: string; preset_id: string | null }
interface OAuthFlow {
  start(userId: string, serverId: string, options?: { scopes?: readonly string[] }): Promise<string>;
  complete(state: string, code: string): Promise<{ serverId: string; revision?: number }>;
}

/** Shared lifecycle for raw MCP routes, reviewed connectors and account deletion. */
export function createManagedPresetLifecycle(options: {
  db: { getCustomMcpServerForBroker(serverId: string, userId: string): Promise<SelectedPreset | null> };
  oauth: OAuthFlow;
  bokioOAuth: OAuthFlow;
  bokioBroker: { disconnect(userId: string, connectionId: string): Promise<boolean> };
  activatePreset(input: { userId: string; presetId: string; allowedTools: readonly string[]; requiredTools: readonly string[]; expectedRevision: number }): Promise<unknown>;
  decodeState(state: string): { kind?: unknown; userId?: unknown };
}) {
  return {
    oauth: {
      start: async (userId: string, serverId: string) => {
        const row = await options.db.getCustomMcpServerForBroker(serverId, userId);
        if (!row || row.user_id !== userId || row.id !== serverId) throw new Error("Integration account unavailable");
        if (row.preset_id === "bokio") return options.bokioOAuth.start(userId, serverId);
        const preset = row.preset_id && Object.hasOwn(MANAGED_INTEGRATIONS, row.preset_id)
          ? MANAGED_INTEGRATIONS[row.preset_id] : undefined;
        return preset?.scopes
          ? options.oauth.start(userId, serverId, { scopes: preset.scopes })
          : options.oauth.start(userId, serverId);
      },
      complete: async (state: string, code: string) => {
        const decoded = options.decodeState(state);
        if (decoded.kind === "bokio") return options.bokioOAuth.complete(state, code);
        const result = await options.oauth.complete(state, code);
        if (typeof decoded.userId !== "string") throw new Error("Integration account unavailable");
        const row = await options.db.getCustomMcpServerForBroker(result.serverId, decoded.userId);
        const preset = row?.preset_id && Object.hasOwn(MANAGED_INTEGRATIONS, row.preset_id)
          ? MANAGED_INTEGRATIONS[row.preset_id] : undefined;
        if (preset && !Number.isSafeInteger(result.revision)) throw new Error("Integration account unavailable");
        if (preset) await options.activatePreset({ userId: decoded.userId, presetId: preset.id,
          allowedTools: [...new Set(Object.values(preset.actions).flatMap(action => [...action.tools]))], requiredTools: [], expectedRevision: result.revision! });
        return result;
      },
    },
    removeManagedPreset: async (userId: string, row: SelectedPreset, _runtimeDestroyed: boolean): Promise<boolean> => {
      if (row.user_id !== userId) throw new Error("Integration account unavailable");
      if (row.preset_id !== "bokio") return false;
      // Bokio REST credentials never create a runtime MCP projection. Its own
      // disconnect revokes the exact company grant before revision-fenced deletion.
      if (!await options.bokioBroker.disconnect(userId, row.id)) throw new Error("Integration account unavailable");
      return true;
    },
  };
}
