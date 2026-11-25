/**
 * Org policy for managed preset calls (spec 2691, "Org scope").
 *
 * Integrations reaches Granola and the managed OAuth presets through the
 * broker's `callManagedPresetTool`, and Bokio through its own client. Neither
 * passes the Core tool service, so this gate applies the same org decision on
 * those paths: an admin block denies the next call here too. It fails closed
 * when policy, the owner's actor id, or the preset row cannot be resolved.
 */
export class OrgMcpPolicyDeniedError extends Error {
  readonly code = "org_policy_denied";
  constructor() {
    super("Organization policy does not allow this call");
    this.name = "OrgMcpPolicyDeniedError";
  }
}

interface PresetGateOptions {
  policy: { evaluate(input: { actorId: string; serverUrl: string; toolName: string }): Promise<{ allowed: boolean }> };
  /** Maps the platform user id to the actor id org membership is keyed by. */
  resolveActorId(userId: string): Promise<string | null | undefined>;
}

interface ManagedPresetToolCall { userId: string; serverId: string; presetId: string; toolName: string }

export function createOrgMcpPresetGate(options: PresetGateOptions) {
  async function assertAllowed(input: { userId: string; serverUrl: string | null | undefined; toolName: string }): Promise<void> {
    let allowed = false;
    try {
      const actorId = await options.resolveActorId(input.userId);
      if (actorId && input.serverUrl) {
        allowed = (await options.policy.evaluate({ actorId, serverUrl: input.serverUrl, toolName: input.toolName })).allowed;
      }
    } catch (error: unknown) {
      console.error("[org-mcp] org policy unavailable; preset call refused", error instanceof Error ? error.name : "UnknownError");
    }
    if (!allowed) throw new OrgMcpPolicyDeniedError();
  }

  return {
    /** The same broker, with `callManagedPresetTool` checked against org policy first. */
    governBroker<B extends {
      getPreset(userId: string, presetId: string): Promise<{ id: string; url: string } | null | undefined>;
      callManagedPresetTool(input: never): Promise<unknown>;
    }>(broker: B): B {
      const gated = async (input: ManagedPresetToolCall) => {
        const preset = await broker.getPreset(input.userId, input.presetId);
        await assertAllowed({ userId: input.userId, serverUrl: preset?.id === input.serverId ? preset.url : null, toolName: input.toolName });
        return broker.callManagedPresetTool(input as never);
      };
      return new Proxy(broker, {
        get(target, property) {
          if (property === "callManagedPresetTool") return gated;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    },
    /** For a preset broker that calls its provider directly: each action is checked by its action id. */
    governPresetBroker<P extends { call(input: { userId: string; actionId: string }): Promise<unknown> }>(presetBroker: P, serverUrl: string): P {
      return { ...presetBroker, call: async (input: Parameters<P["call"]>[0]) => {
        await assertAllowed({ userId: input.userId, serverUrl, toolName: input.actionId });
        return presetBroker.call(input);
      } };
    },
  };
}
