export interface HermesStatus {
  installationId: string | null;
  readiness: string;
  gatewayStatus: string;
  version: string | null;
  defaultProfileId: string | null;
  defaultModelId?: string;
  counts: {
    channels: number;
    connectedChannels: number;
    activeSessions: number;
    pendingApprovals: number;
    needsAttention: number;
  };
  lastCheckedAt: string | null;
}

export interface HermesConfig {
  installation: {
    id: string;
    readiness: string;
    gatewayStatus: string;
    defaultProfileId: string;
    defaultModelId?: string;
    authorizedOperators: string[];
  } | null;
  setupSteps: Array<{ id: string; status: string; title: string; detail: string; required: boolean }>;
  modelProviders: Array<{ id: string; configured: boolean; status: string; defaultModelId?: string }>;
  channels: HermesChannel[];
  capabilities: Array<{ id: string; kind: string; name: string; enabled: boolean; status: string; description: string }>;
  sessions: HermesSession[];
  approvals: Array<{ id: string; sessionId: string; status: string; description: string; requestedTool?: string }>;
  events: Array<{ id: string; category: string; severity: string; message: string; createdAt: string }>;
}

export interface HermesChannel {
  id: string;
  platform: string;
  enabled: boolean;
  configured: boolean;
  status: string;
  allowedSenderPolicy: string;
  homeChannel?: string;
  updatedAt: string;
}

export interface HermesSession {
  id: string;
  status: string;
  profileId: string;
  modelId?: string;
  eventCount: number;
  updatedAt: string;
  lastActiveAt?: string;
}

export interface HermesEvent {
  id: string;
  type: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    signal: init?.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("request_failed");
  return await response.json() as T;
}

export const hermesApi = {
  status: () => fetchJson<HermesStatus>("/api/hermes/status"),
  config: () => fetchJson<HermesConfig>("/api/hermes/config"),
  saveConfig: (body: { defaultProfileId: string; defaultModelId?: string; authorizedOperators: string[]; hermesPath?: string }) =>
    fetchJson<HermesConfig>("/api/hermes/config", { method: "POST", body: JSON.stringify({ homeMode: "default", ...body }) }),
  saveModelCredential: (body: { providerId: string; secret: string }) =>
    fetchJson<{ configured: boolean; providerId: string; status: string }>("/api/hermes/credentials/model", { method: "POST", body: JSON.stringify(body) }),
  channelAction: (channelId: "telegram" | "whatsapp", type: string, payload: Record<string, unknown> = {}) =>
    fetchJson<{ channel: HermesChannel }>(`/api/hermes/channels/${channelId}/action`, { method: "POST", body: JSON.stringify({ type, payload }) }),
  createSession: (body: { prompt: string; profileId: string; modelId?: string }) =>
    fetchJson<{ session: HermesSession }>("/api/hermes/sessions", { method: "POST", body: JSON.stringify({ ...body, clientRequestId: crypto.randomUUID() }) }),
  sendPrompt: (sessionId: string, prompt: string) =>
    fetchJson<{ session: HermesSession }>(`/api/hermes/sessions/${sessionId}/prompt`, { method: "POST", body: JSON.stringify({ prompt, clientRequestId: crypto.randomUUID() }) }),
  decideApproval: (approvalId: string, decision: "approved" | "denied") =>
    fetchJson(`/api/hermes/approvals/${approvalId}/decision`, { method: "POST", body: JSON.stringify({ decision }) }),
  gatewayAction: (type: "restart" | "health_check" | "update") =>
    fetchJson<{ operation: { id: string; status: string; message: string } }>("/api/hermes/gateway/action", { method: "POST", body: JSON.stringify({ type }) }),
  recover: () => fetchJson<{ recovery: { status: string; message: string } }>("/api/hermes/recover", { method: "POST", body: JSON.stringify({}) }),
  audit: () => fetchJson<{ events: HermesConfig["events"] }>("/api/hermes/audit"),
  exportConfig: () => fetchJson<HermesConfig>("/api/hermes/export"),
};
