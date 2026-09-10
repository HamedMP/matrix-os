import {
  ProviderSettingsMutationResponseSchema,
  ProviderSettingsMutationSchema,
  ProviderSettingsSnapshotSchema,
  type ProviderSettingsMutation,
  type ProviderSettingsMutationResponse,
  type ProviderSettingsSnapshot,
  type ProviderHarnessKind,
} from "@matrix-os/contracts";
import { openProviderAgentSetup, ProviderSettingsTransportError } from "@matrix-os/ui";
import { isCanonicalShellSessionId } from "../components/terminal/terminal-session-id";
import { getGatewayUrl } from "./gateway";
import { PROVIDER_SETTINGS_CHANGED_EVENT } from "./canonical-provider-setup";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_MUTATION_BYTES = 64 * 1024;

export { ProviderSettingsTransportError } from "@matrix-os/ui";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderSettingsTransport {
  getSnapshot(signal?: AbortSignal, options?: { refresh?: boolean }): Promise<ProviderSettingsSnapshot>;
  mutate(mutation: ProviderSettingsMutation, signal?: AbortSignal): Promise<ProviderSettingsMutationResponse>;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ProviderSettingsTransportError("invalid_response");
  }
  if (!response.body) {
    throw new ProviderSettingsTransportError("invalid_response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ProviderSettingsTransportError("invalid_response");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ProviderSettingsTransportError) throw error;
    throw new ProviderSettingsTransportError("invalid_response");
  }
}

async function fetchJson(
  fetcher: Fetcher,
  path: string,
  init: RequestInit,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(`${getGatewayUrl()}${path}`, init);
  } catch (error) {
    console.warn("[provider-settings] Provider settings request failed:", error instanceof Error ? error.name : typeof error);
    throw new ProviderSettingsTransportError("unavailable");
  }
  if (!response.ok) {
    let value: unknown;
    try {
      value = await boundedJson(response);
    } catch (error) {
      console.warn("[provider-settings] Provider settings error response was invalid:", error instanceof Error ? error.name : typeof error);
      throw new ProviderSettingsTransportError("unavailable");
    }
    const code = value && typeof value === "object"
      && "error" in value && value.error && typeof value.error === "object"
      && "code" in value.error && typeof value.error.code === "string"
      ? value.error.code
      : null;
    if (code === "revision_conflict"
      || code === "idempotency_conflict"
      || code === "provider_settings_unavailable") {
      throw new ProviderSettingsTransportError(code);
    }
    throw new ProviderSettingsTransportError("unavailable");
  }
  return await boundedJson(response);
}

export function createProviderSettingsTransport(
  options: { fetcher?: Fetcher } = {},
): ProviderSettingsTransport {
  const fetcher = options.fetcher ?? fetch;
  return {
    async getSnapshot(signal, options = {}) {
      const value = await fetchJson(fetcher, `/api/ai/provider-settings${options.refresh ? "?refresh=true" : ""}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: requestSignal(signal),
      });
      const parsed = ProviderSettingsSnapshotSchema.safeParse(value);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      return parsed.data;
    },
    async mutate(input, signal) {
      const mutation = ProviderSettingsMutationSchema.safeParse(input);
      if (!mutation.success) throw new ProviderSettingsTransportError("invalid_request");
      const body = JSON.stringify(mutation.data);
      if (new TextEncoder().encode(body).byteLength > MAX_MUTATION_BYTES) {
        throw new ProviderSettingsTransportError("invalid_request");
      }
      const value = await fetchJson(fetcher, "/api/ai/provider-settings/actions", {
        method: "POST",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body,
        signal: requestSignal(signal),
      });
      const parsed = ProviderSettingsMutationResponseSchema.safeParse(value);
      if (!parsed.success) throw new ProviderSettingsTransportError("invalid_response");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(PROVIDER_SETTINGS_CHANGED_EVENT));
      }
      return parsed.data;
    },
  };
}

export async function openWebProviderAgentSetup(
  harness: ProviderHarnessKind,
  onOpenTerminal: (sessionId: string) => void,
): Promise<boolean> {
  const runtimeUrl = getGatewayUrl();
  return openProviderAgentSetup({
    harness,
    getCatalog: () => fetchJson(fetch, "/api/chat-providers?refresh=true&includeConnectionLabels=true", { signal: requestSignal(), cache: "no-store" }),
    openCommand: async (cmd) => {
      if (getGatewayUrl() !== runtimeUrl) return false;
      const name = `setup-${harness}-${crypto.randomUUID().slice(0, 8)}`;
      const value = await fetchJson(fetch, "/api/terminal/sessions", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, cwd: "projects", cmd }), signal: requestSignal(),
      });
      const sessionId = value && typeof value === "object" && "name" in value ? value.name : null;
      if (getGatewayUrl() !== runtimeUrl || typeof sessionId !== "string" || !isCanonicalShellSessionId(sessionId)) return false;
      onOpenTerminal(sessionId);
      return true;
    },
  });
}
