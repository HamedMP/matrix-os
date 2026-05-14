import { normalizeMatrixDesktopUrl } from "./security.js";
import { DESKTOP_CAPABILITIES } from "../../../../packages/gateway/src/desktop/capabilities.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type DesktopAgentMode = "cloud";

export interface MatrixDesktopConfig {
  shellUrl: string;
  gatewayUrl: string;
  agentMode: DesktopAgentMode;
}

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

export interface DesktopWindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
  lastLoadedUrl?: string;
  lastFailureAt?: string;
}

export interface DesktopLaunchPlan {
  loadUrl: string;
  allowedOrigins: string[];
  reconnect: {
    enabled: true;
    lastLoadedUrl?: string;
    lastFailureAt?: string;
  };
}

const DEFAULT_SHELL_URL = "http://localhost:3000";
const DEFAULT_GATEWAY_URL = "http://localhost:4000";
const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;
const MAX_WINDOW_WIDTH = 7680;
const MAX_WINDOW_HEIGHT = 4320;
export const DEFAULT_DESKTOP_WINDOW_STATE: DesktopWindowState = {
  width: 1440,
  height: 960,
  maximized: false,
};

export function parseMatrixDesktopConfig(env: NodeJS.ProcessEnv = process.env): MatrixDesktopConfig {
  const requestedMode = env.MATRIX_DESKTOP_AGENT_MODE ?? "cloud";
  if (requestedMode !== "cloud") {
    throw new Error("Matrix Desktop is cloud-only; local coding agents are not supported");
  }

  try {
    return {
      shellUrl: normalizeMatrixDesktopUrl(env.MATRIX_DESKTOP_SHELL_URL ?? DEFAULT_SHELL_URL),
      gatewayUrl: normalizeMatrixDesktopUrl(env.MATRIX_DESKTOP_GATEWAY_URL ?? DEFAULT_GATEWAY_URL),
      agentMode: "cloud",
    };
  } catch (err: unknown) {
    if (!(err instanceof Error)) {
      console.warn("[desktop] Unknown desktop configuration parse failure");
    }
    throw new Error("Invalid Matrix desktop configuration");
  }
}

export function createDesktopRuntimePolicy(config: MatrixDesktopConfig): DesktopRuntimePolicy {
  return {
    agentExecution: { mode: "cloud", localAgentsAllowed: false },
    capabilities: [...DESKTOP_CAPABILITIES],
    gatewayHealth: "healthy",
    instance: {
      shellUrl: config.shellUrl,
      gatewayUrl: config.gatewayUrl,
      version: "desktop",
    },
    version: 1,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedDimension(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

function optionalCoordinate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || Math.abs(value) > 100_000) {
    return undefined;
  }
  return value;
}

function optionalIsoString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : value;
}

function optionalDesktopUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) {
    return undefined;
  }
  try {
    return normalizeMatrixDesktopUrl(value);
  } catch (err: unknown) {
    if (!(err instanceof Error)) {
      console.warn("[desktop] Unknown persisted URL parse failure");
    }
    return undefined;
  }
}

function sanitizeDesktopWindowState(value: unknown): DesktopWindowState {
  if (!isRecord(value)) {
    return { ...DEFAULT_DESKTOP_WINDOW_STATE };
  }

  return {
    width: boundedDimension(
      value.width,
      DEFAULT_DESKTOP_WINDOW_STATE.width,
      MIN_WINDOW_WIDTH,
      MAX_WINDOW_WIDTH,
    ),
    height: boundedDimension(
      value.height,
      DEFAULT_DESKTOP_WINDOW_STATE.height,
      MIN_WINDOW_HEIGHT,
      MAX_WINDOW_HEIGHT,
    ),
    x: optionalCoordinate(value.x),
    y: optionalCoordinate(value.y),
    maximized: value.maximized === true,
    lastLoadedUrl: optionalDesktopUrl(value.lastLoadedUrl),
    lastFailureAt: optionalIsoString(value.lastFailureAt),
  };
}

export async function loadDesktopWindowState(path: string): Promise<DesktopWindowState> {
  try {
    const raw = await readFile(path, "utf-8");
    return sanitizeDesktopWindowState(JSON.parse(raw));
  } catch (err: unknown) {
    if (err instanceof SyntaxError) {
      return { ...DEFAULT_DESKTOP_WINDOW_STATE };
    }
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return { ...DEFAULT_DESKTOP_WINDOW_STATE };
    }
    console.warn("[desktop] Failed to load window state", err instanceof Error ? err.name : "UnknownError");
    return { ...DEFAULT_DESKTOP_WINDOW_STATE };
  }
}

export async function saveDesktopWindowState(path: string, state: Partial<DesktopWindowState>): Promise<void> {
  const sanitized = sanitizeDesktopWindowState({
    ...DEFAULT_DESKTOP_WINDOW_STATE,
    ...state,
  });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(sanitized, null, 2)}\n`, { flag: "w" });
}

export function createDesktopLaunchPlan(
  config: MatrixDesktopConfig,
  state: Partial<DesktopWindowState> = {},
): DesktopLaunchPlan {
  const shellUrl = normalizeMatrixDesktopUrl(config.shellUrl);
  const gatewayUrl = normalizeMatrixDesktopUrl(config.gatewayUrl);
  const allowedOrigins = Array.from(new Set([new URL(shellUrl).origin, new URL(gatewayUrl).origin]));
  return {
    loadUrl: shellUrl,
    allowedOrigins,
    reconnect: {
      enabled: true,
      lastLoadedUrl: optionalDesktopUrl(state.lastLoadedUrl),
      lastFailureAt: optionalIsoString(state.lastFailureAt),
    },
  };
}
