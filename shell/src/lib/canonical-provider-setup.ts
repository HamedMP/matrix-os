import type {
  CanonicalProviderInstanceDescriptor,
  CanonicalProviderSetupAction,
} from "@matrix-os/contracts";
import { isCanonicalShellSessionId } from "../components/terminal/terminal-session-id";
import { getGatewayUrl } from "./gateway";

const RESPONSE_LIMIT_BYTES = 64 * 1024;
const ACTION_PREFIX_LIMIT = 18;
export const OPEN_PROVIDER_SETTINGS_EVENT = "matrix:open-provider-settings";
export const OPEN_PROVIDER_TERMINAL_EVENT = "matrix:open-provider-terminal";
export const PROVIDER_SETTINGS_CHANGED_EVENT = "matrix:provider-settings-changed";
export const CANONICAL_PROVIDER_SETUP_ERROR = "Could not open setup. Open Settings to continue.";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function sameAction(
  left: CanonicalProviderSetupAction,
  right: CanonicalProviderSetupAction,
): boolean {
  if (left.id !== right.id || left.kind !== right.kind || left.label !== right.label) return false;
  return left.kind === "open_settings"
    || (right.kind === "foreground_terminal" && left.command === right.command);
}

function actionPrefix(instance: CanonicalProviderInstanceDescriptor): string {
  return instance.driverKind === "claude_code" ? "claude" : instance.driverKind;
}

function sessionName(instance: CanonicalProviderInstanceDescriptor): string {
  const driver = instance.driverKind
    .replaceAll("_", "-")
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, ACTION_PREFIX_LIMIT) || "agent";
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "").slice(0, 8)
    ?? Date.now().toString(36).slice(-8);
  return `setup-${driver}-${random}`.slice(0, 31).replace(/-+$/g, "");
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > RESPONSE_LIMIT_BYTES) return null;
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > RESPONSE_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch (error: unknown) {
    console.warn("[chat] Invalid provider setup response:", error instanceof Error ? error.name : typeof error);
    return null;
  }
}

export function providerTerminalSessionFromEvent(event: Event): string | null {
  if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== "object") return null;
  const sessionId = (event.detail as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && isCanonicalShellSessionId(sessionId) ? sessionId : null;
}

export async function executeCanonicalProviderSetupAction(input: {
  instance: CanonicalProviderInstanceDescriptor;
  action: CanonicalProviderSetupAction;
  fetcher?: Fetcher;
}): Promise<boolean> {
  if (!input.instance.setupActions.some((candidate) => sameAction(candidate, input.action))) return false;
  if (input.action.kind === "open_settings") {
    window.dispatchEvent(new CustomEvent(OPEN_PROVIDER_SETTINGS_EVENT));
    return true;
  }
  if (!input.action.id.startsWith(`${actionPrefix(input.instance)}_`)) return false;
  try {
    const response = await (input.fetcher ?? fetch)(`${getGatewayUrl()}/api/terminal/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: sessionName(input.instance),
        cwd: "projects",
        cmd: input.action.command,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return false;
    const value = await boundedJson(response);
    const sessionId = value && typeof value === "object"
      ? (value as { name?: unknown }).name
      : null;
    if (typeof sessionId !== "string" || !isCanonicalShellSessionId(sessionId)) return false;
    window.dispatchEvent(new CustomEvent(OPEN_PROVIDER_TERMINAL_EVENT, { detail: { sessionId } }));
    return true;
  } catch (error: unknown) {
    console.warn("[chat] Provider setup action failed:", error instanceof Error ? error.name : typeof error);
    return false;
  }
}
