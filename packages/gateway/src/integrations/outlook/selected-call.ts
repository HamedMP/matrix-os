import type { ConnectedServicesTable } from "../../platform-db.js";
import { OutlookError } from "./http.js";
import type { OutlookGraph } from "./graph.js";
import { isNativeOutlookConnection } from "./store.js";

export function selectedOutlookCall(options: {
  outlook?: OutlookGraph;
  connection: ConnectedServicesTable;
  userId: string;
  action: string;
  params?: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<{ data: unknown; summary?: string }> | undefined {
  const { outlook, connection, userId, action, params, signal } = options;
  if (!isNativeOutlookConnection(connection)) return undefined;
  if (!outlook || connection.user_id !== userId || connection.status !== "active") {
    return Promise.reject(new OutlookError("unavailable"));
  }
  return outlook({ userId, connectionId: connection.id, service: connection.service, action, params, signal })
    .then(data => ({ data }));
}
