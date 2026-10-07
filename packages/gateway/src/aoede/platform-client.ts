import WebSocket from "ws";
import { z } from "zod/v4";
import type { AoedeStartRequest, AoedeTranscript } from "@matrix-os/contracts";
import { loadPlatformSpeechRuntimeConfig, type PlatformSpeechRuntimeConfig } from "../speech/platform-client.js";

const ProviderId = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const MintResponse = z.object({ providerSessionId: ProviderId, sdp: z.string().min(1).max(60_000) }).strict();
export interface AoedeSideband { send(frame: Record<string, unknown>): void; close(): void }
export interface AoedePlatformClient {
  ownerId: string; runtimeId: string;
  mint(input: AoedeStartRequest & { instructions: string; input: AoedeTranscript[] }): Promise<z.infer<typeof MintResponse>>;
  attach(id: string, onEvent: (event: unknown) => void, onDisconnect: () => void): Promise<AoedeSideband>;
  close(id: string): Promise<void>;
}
export class AoedePlatformError extends Error {
  constructor() { super("Voice service unavailable"); }
}

// No Gemini fallback or provider key. Config loader is the existing validated speech-domain authority.
export function loadAoedePlatformClient(env: NodeJS.ProcessEnv = process.env): AoedePlatformClient | undefined {
  const config = loadPlatformSpeechRuntimeConfig(env);
  return config ? createAoedePlatformClient(config) : undefined;
}
export function createAoedePlatformClient(config: PlatformSpeechRuntimeConfig, deps: { fetchFn?: typeof fetch } = {}): AoedePlatformClient {
  const fetchFn = deps.fetchFn ?? fetch;
  const base = config.baseUrl.replace(/\/speech$/, "/aoede");
  if (base === config.baseUrl) throw new AoedePlatformError();
  function url(path: string) {
    const target = new URL(base + path);
    target.searchParams.set("runtimeSlot", config.identity.runtimeSlot);
    return target;
  }
  const headers = { authorization: `Bearer ${config.runtimeAuthToken}`, "content-type": "application/json" };
  async function request(path: string, method: string, body?: unknown) {
    const response = await fetchFn(url(path), { method, headers, redirect: "error",
      signal: AbortSignal.timeout(15_000), body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) { await response.body?.cancel(); throw new AoedePlatformError(); }
    return response;
  }
  return {
    ownerId: config.requestOwnerId,
    runtimeId: `${config.identity.machineId}/${config.identity.runtimeSlot}`,
    async mint(input) {
      const response = await request("/session", "POST", { ...input,
        input: input.input.map((t) => ({ role: t.role,
          content: [{ type: t.role === "user" ? "input_text" : "output_text", text: t.text }] })) });
      const reader = response.body?.getReader();
      if (!reader) throw new AoedePlatformError();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength;
          if (size > 64 * 1024) { await reader.cancel(); throw new AoedePlatformError(); }
          chunks.push(next.value);
        }
        return MintResponse.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } finally { reader.releaseLock(); }
    },
    async close(id) { await (await request(`/sessions/${ProviderId.parse(id)}`, "DELETE")).body?.cancel(); },
    async attach(id, onEvent, onDisconnect) {
      const target = url(`/sessions/${ProviderId.parse(id)}/attach`);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(target, { headers, handshakeTimeout: 10_000, maxPayload: 512 * 1024,
        followRedirects: false });
      // Install reception before open resolves; do not lose an immediate first event.
      ws.on("message", (raw, binary) => {
        if (binary) return;
        try { onEvent(JSON.parse(raw.toString())); }
        catch (error) { console.warn("[aoede] invalid sideband frame", error instanceof Error ? error.name : "UnknownError"); }
      });
      ws.on("error", (error) => console.warn("[aoede] sideband failure", error.name));
      ws.on("close", onDisconnect);
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { ws.terminate(); reject(new AoedePlatformError()); }, 10_000);
        ws.once("open", () => { clearTimeout(timer); resolve(); });
        ws.once("error", () => { clearTimeout(timer); reject(new AoedePlatformError()); });
        ws.once("close", () => { clearTimeout(timer); reject(new AoedePlatformError()); });
      });
      return {
        send(frame) {
          if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 64 * 1024) throw new AoedePlatformError();
          ws.send(JSON.stringify(frame));
        },
        close() { ws.removeListener("close", onDisconnect); ws.terminate(); },
      };
    },
  };
}
