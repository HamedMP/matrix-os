import type { ConnectionState } from "@/hooks/useConnectionHealth";

export type ConnectionFailureLayer =
  | "browser-network"
  | "credential"
  | "public-route"
  | "platform-route"
  | "runtime-reachable"
  | "runtime-unreachable"
  | "deploy-restart"
  | "unknown";

export interface ConnectionDiagnosticInput {
  event: "connected" | "closed" | "credential_refresh_failed" | "reconnect_exhausted" | "runtime_probe";
  layer: ConnectionFailureLayer;
  state: ConnectionState;
  attempt: number;
  route: "/ws" | "/health" | "/api/system/info";
  visibility?: string;
  closeCode?: number;
  wasClean?: boolean;
  reconnectDurationMs?: number;
  runtimeReachability?: "checking" | "online" | "unavailable";
}

export interface ConnectionDiagnosticSnapshot extends ConnectionDiagnosticInput {
  id: string;
  at: number;
}

const MAX_CONNECTION_DIAGNOSTICS = 50;
const diagnostics: ConnectionDiagnosticSnapshot[] = [];
let diagnosticSeq = 0;

export function classifySocketClose(
  evt: Pick<CloseEvent, "code" | "wasClean"> | undefined,
  online = typeof navigator === "undefined" ? true : navigator.onLine,
): ConnectionFailureLayer {
  if (!online) return "browser-network";
  if (evt?.code === 1012 || evt?.code === 1013) return "deploy-restart";
  if (evt && !evt.wasClean) return "public-route";
  return "unknown";
}

export function recordConnectionDiagnostic(input: ConnectionDiagnosticInput): ConnectionDiagnosticSnapshot {
  diagnosticSeq = (diagnosticSeq + 1) & 0xffff;
  const snapshot: ConnectionDiagnosticSnapshot = {
    ...input,
    id: `conn-${Date.now()}-${diagnosticSeq}`,
    at: Date.now(),
  };
  diagnostics.push(snapshot);
  while (diagnostics.length > MAX_CONNECTION_DIAGNOSTICS) {
    diagnostics.shift();
  }
  return snapshot;
}

export function getConnectionDiagnostics(): ConnectionDiagnosticSnapshot[] {
  return diagnostics.map((entry) => ({ ...entry }));
}

export function resetConnectionDiagnosticsForTests(): void {
  diagnostics.length = 0;
  diagnosticSeq = 0;
}
