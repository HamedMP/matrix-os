import type { ManagedMcpPresetBroker } from "./granola-preset-broker.js";
export function createManagedPresetRouter(brokers: Readonly<Record<string, ManagedMcpPresetBroker>>): ManagedMcpPresetBroker {
  const select = (service: unknown) => {
    const id = service && typeof service === "object" ? (service as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !Object.hasOwn(brokers, id)) throw new Error("Integration unavailable");
    return brokers[id]!;
  };
  const unique = [...new Set(Object.values(brokers))];
  return {
    listConnections: async userId => (await Promise.all(unique.map(b => b.listConnections(userId)))).flat(),
    listActionCapabilities: async (userId, serviceId) => brokers[serviceId]?.listActionCapabilities?.(userId, serviceId) ?? null,
    listAvailableActions: async (userId, serviceId) => brokers[serviceId]?.listAvailableActions(userId, serviceId) ?? null,
    listAvailableActionParams: async (userId, serviceId) => brokers[serviceId]?.listAvailableActionParams(userId, serviceId) ?? null,
    connect: (userId, service) => select(service).connect(userId, service),
    call: input => select(input.service).call(input),
    disconnect: async (userId, connectionId) => {
      for (const b of unique) if (await b.disconnect(userId, connectionId)) return true;
      return false;
    },
  };
}
