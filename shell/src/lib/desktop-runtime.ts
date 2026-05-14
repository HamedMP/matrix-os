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

export type DesktopRuntimeKind = "browser" | "desktop";
export type DesktopLaunchSurface = "native-tab" | "shell-window";

export interface DesktopAppAffordance {
  launchSurface: DesktopLaunchSurface;
  defaultApp: boolean;
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
const DESKTOP_ERROR_ALLOWLIST = new Set([
  "Desktop runtime unavailable",
  "Workspace request failed",
  "Cloud agent runtime required",
  "Ticket assignment failed",
  "Symphony request failed",
]);
const DESKTOP_DEFAULT_APP_PATHS = new Set([
  "__workspace__",
  "__terminal__",
  "__file-browser__",
  "symphony",
]);

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && typeof window.matrixDesktop === "object";
}

export function getDesktopRuntimeKind(target: Pick<Window, "matrixDesktop"> | undefined = typeof window !== "undefined" ? window : undefined): DesktopRuntimeKind {
  return target?.matrixDesktop ? "desktop" : "browser";
}

export function isDesktopDefaultApp(path: string): boolean {
  const normalized = path.replace(/^\/files\//, "").replace(/^apps\/symphony\/index\.html$/, "symphony");
  return DESKTOP_DEFAULT_APP_PATHS.has(normalized) || normalized.startsWith("__terminal__:");
}

export function getDesktopAppAffordance(
  path: string,
  runtime: DesktopRuntimeKind = getDesktopRuntimeKind(),
): DesktopAppAffordance {
  const defaultApp = isDesktopDefaultApp(path);
  return {
    defaultApp,
    launchSurface: runtime === "desktop" && defaultApp ? "native-tab" : "shell-window",
  };
}

export function safeDesktopClientError(value: unknown): string {
  if (!(value instanceof Error) || value.message.length > MAX_CLIENT_ERROR_LENGTH) {
    return SAFE_CLIENT_ERROR;
  }
  if (/(token|secret|key|password|credential|passphrase|\/Users\/|\/home\/|\/root\/|\/opt\/|[A-Za-z]:\\|postgres|database|anthropic|linear)/i.test(value.message)) {
    return SAFE_CLIENT_ERROR;
  }
  return DESKTOP_ERROR_ALLOWLIST.has(value.message) ? value.message : SAFE_CLIENT_ERROR;
}

export function desktopSafeErrorMessage(value: unknown): string {
  if (!(value instanceof Error)) return SAFE_CLIENT_ERROR;
  if (DESKTOP_ERROR_ALLOWLIST.has(value.message)) return value.message;
  return safeDesktopClientError(value);
}

export async function getDesktopRuntimePolicy(): Promise<DesktopRuntimePolicy> {
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
