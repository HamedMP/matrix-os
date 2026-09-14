import {
  GRANOLA_PRESET,
  availableGranolaActions,
  planGranolaAction,
} from "./granola-integration.js";

interface GranolaPresetRow {
  id: string;
  status: string;
  created_at: Date | string;
  tools: Array<{ name: string; inputSchema?: unknown }>;
}

export interface GranolaPresetRuntime {
  getPreset(userId: string, presetId: string): Promise<GranolaPresetRow | null>;
  ensurePreset(input: {
    userId: string;
    presetId: string;
    name: string;
    url: string;
  }): Promise<GranolaPresetRow>;
  activatePreset(input: {
    userId: string;
    presetId: string;
    allowedTools: readonly string[];
    requiredTools?: readonly string[];
  }): Promise<GranolaPresetRow>;
  callSelectedTool(input: {
    userId: string;
    serverId: string;
    toolName: string;
    arguments?: Record<string, unknown>;
    approvalGranted: boolean;
  }): Promise<unknown>;
  remove(userId: string, serverId: string): Promise<void>;
}

export interface GranolaOAuthRuntime {
  start(userId: string, serverId: string): Promise<string>;
}

export interface ManagedMcpPresetBroker {
  listConnections(userId: string): Promise<Array<{
    id: string;
    service: string;
    account_label: string;
    account_email: null;
    scopes: string[];
    status: string;
    connected_at: Date | string;
    last_used_at: null;
  }>>;
  listAvailableActions(userId: string, serviceId: string): Promise<readonly string[] | null>;
  connect(userId: string, service: unknown): Promise<{ url: string }>;
  call(input: {
    userId: string;
    service: unknown;
    actionId: string;
    params?: Record<string, unknown>;
  }): Promise<unknown>;
  disconnect(userId: string, connectionId: string): Promise<boolean>;
}

function activationInput(userId: string) {
  return {
    userId,
    presetId: GRANOLA_PRESET.id,
    allowedTools: GRANOLA_PRESET.tools,
    requiredTools: GRANOLA_PRESET.requiredTools,
  };
}

export function createGranolaPresetBroker(dependencies: {
  broker: GranolaPresetRuntime;
  oauth: GranolaOAuthRuntime;
}): ManagedMcpPresetBroker {
  const { broker, oauth } = dependencies;
  return {
    listAvailableActions: async (userId, serviceId) => {
      if (serviceId !== GRANOLA_PRESET.id) return null;
      let row = await broker.getPreset(userId, GRANOLA_PRESET.id);
      if (!row) return null;
      if (row.status === "disabled") {
        try {
          row = await broker.activatePreset(activationInput(userId));
        } catch (error: unknown) {
          console.warn(
            "[granola] capability activation pending:",
            error instanceof Error ? error.message : String(error),
          );
          return [];
        }
      }
      return row.status === "ready" ? availableGranolaActions(row.tools) : [];
    },
    listConnections: async (userId) => {
      let row = await broker.getPreset(userId, GRANOLA_PRESET.id);
      if (!row) return [];
      if (row.status === "disabled") {
        try {
          row = await broker.activatePreset(activationInput(userId));
        } catch (error: unknown) {
          console.warn(
            "[granola] preset activation pending:",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return [{
        id: row.id,
        service: GRANOLA_PRESET.id,
        account_label: GRANOLA_PRESET.name,
        account_email: null,
        scopes: [],
        status: row.status === "ready" ? "active" : row.status,
        connected_at: row.created_at,
        last_used_at: null,
      }];
    },
    connect: async (userId) => {
      const row = await broker.ensurePreset({
        userId,
        presetId: GRANOLA_PRESET.id,
        name: GRANOLA_PRESET.name,
        url: GRANOLA_PRESET.url,
      });
      return { url: await oauth.start(userId, row.id) };
    },
    call: async ({ userId, actionId, params }) => {
      const row = await broker.activatePreset(activationInput(userId));
      const plan = planGranolaAction(actionId, params, row.tools);
      const results: unknown[] = [];
      for (const call of plan.calls) {
        results.push(await broker.callSelectedTool({
          userId,
          serverId: row.id,
          toolName: call.toolName,
          arguments: call.arguments,
          approvalGranted: true,
        }));
      }
      return results[0];
    },
    disconnect: async (userId, connectionId) => {
      const row = await broker.getPreset(userId, GRANOLA_PRESET.id);
      if (!row || row.id !== connectionId) return false;
      await broker.remove(userId, connectionId);
      return true;
    },
  };
}
