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
