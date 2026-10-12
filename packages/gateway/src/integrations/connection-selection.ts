export const AMBIGUOUS_CONNECTION_ERROR = "Integration account label is ambiguous";

// The caller supplies only the authenticated owner's active connections.
// Preserve first-service selection for unlabeled calls, but never guess when
// an explicit label identifies more than one connection.
export function resolveIntegrationConnection<T extends { service: string; account_label: string }>(
  connections: readonly T[],
  service: string,
  label?: string,
): { kind: "found"; connection: T } | { kind: "missing" } | { kind: "ambiguous" } {
  if (!label) {
    const connection = connections.find((item) => item.service === service);
    return connection ? { kind: "found", connection } : { kind: "missing" };
  }
  let connection: T | undefined;
  for (const item of connections) {
    if (item.service !== service || item.account_label !== label) continue;
    if (connection) return { kind: "ambiguous" };
    connection = item;
  }
  return connection ? { kind: "found", connection } : { kind: "missing" };
}

/** Resolve the approved account on the authenticated owner's active inventory.
 * An unlabeled legacy call retains the broker's default selection behavior.
 */
export async function resolveManagedIntegrationCall(options: {
  service: string; label?: string; connectionId?: string;
  listConnections(): Promise<readonly { id: string; service: string; account_label: string; status: string }[]>;
}): Promise<{ kind: "legacy" } | { kind: "found"; connectionId: string } | { kind: "denied" } | { kind: "ambiguous" }> {
  if (!options.label && !options.connectionId) return { kind: "legacy" };
  const active = (await options.listConnections()).filter(row => row.status === "active"
    && (!options.connectionId || !!options.label || row.id === options.connectionId));
  const selected = resolveIntegrationConnection(active, options.service, options.label);
  if (selected.kind === "ambiguous") return selected;
  if (selected.kind !== "found" || (options.connectionId && selected.connection.id !== options.connectionId)) {
    return { kind: "denied" };
  }
  return { kind: "found", connectionId: selected.connection.id };
}
