export interface DesktopRuntimePolicy {
  agentExecution: {
    mode: "cloud";
    localAgentsAllowed: false;
  };
  capabilities: string[];
  gatewayHealth: "healthy" | "degraded" | "unreachable";
  instance: {
    shellUrl: string;
    gatewayUrl: string;
    version: string;
  };
  version: 1;
}

declare global {
  interface Window {
    matrixDesktop?: {
      getRuntimePolicy: () => Promise<DesktopRuntimePolicy>;
      openExternal: (url: string) => Promise<{ ok: boolean }>;
    };
  }
}

const SAFE_CLIENT_ERROR = "Request failed";
const MAX_CLIENT_ERROR_LENGTH = 120;

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.matrixDesktop === "object";
}

export function safeDesktopClientError(value: unknown): string {
  if (!(value instanceof Error) || value.message.length > MAX_CLIENT_ERROR_LENGTH) {
    return SAFE_CLIENT_ERROR;
  }
  if (/(token|secret|key|\/Users\/|postgres|database|anthropic|linear)/i.test(value.message)) {
    return SAFE_CLIENT_ERROR;
  }
  return value.message;
}

export async function getDesktopRuntimePolicy(): Promise<DesktopRuntimePolicy | null> {
  if (typeof window !== "undefined" && window.matrixDesktop) {
    return window.matrixDesktop.getRuntimePolicy();
  }

  const response = await fetch("/api/desktop/runtime", {
    signal: AbortSignal.timeout(10_000),
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error("Desktop runtime unavailable");
  }
  return (await response.json()) as DesktopRuntimePolicy;
}
