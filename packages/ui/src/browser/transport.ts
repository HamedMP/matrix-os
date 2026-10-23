import { SharedBrowserStateSchema } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { BrowserStatus } from "./types.js";

const Status = z.strictObject({
  available: z.boolean(), chrome: z.strictObject({ present: z.boolean(), minimized: z.boolean() }),
  humanControlAvailable: z.boolean(),
  automation: SharedBrowserStateSchema.optional(),
});
const Ticket = z.strictObject({ ticket: z.string().regex(/^[a-f0-9]{48}$/), expiresAt: z.number().int().positive() });

export function browserEndpoint(gatewayUrl: string): { origin: string; appBase: string; gatewayPath: string } {
  const url = new URL(gatewayUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Invalid browser gateway");
  const gatewayPath = url.pathname.replace(/\/$/, "");
  if (gatewayPath && !/^\/vm\/[A-Za-z0-9_-]{1,64}(?:\/~runtime\/[A-Za-z0-9_-]{1,32})?$/.test(gatewayPath)) throw new Error("Invalid browser runtime");
  return { origin: url.origin, appBase: `${url.origin}${gatewayPath}/apps/browser-lab`, gatewayPath };
}
export function browserStatus(value: unknown): BrowserStatus { return Status.parse(value); }
export function productViewerUrl(endpoint: ReturnType<typeof browserEndpoint>, value: unknown): string {
  const ticket = Ticket.parse(value);
  if (ticket.expiresAt <= Date.now() || ticket.expiresAt > Date.now() + 600_000) throw new Error("Expired viewer admission");
  const path = `${endpoint.gatewayPath}/apps/browser-lab/viewer/websockify?lab_ticket=${ticket.ticket}`.replace(/^\//, "");
  const query = new URLSearchParams({ path, autoconnect: "true", resize: "remote", matrix_product: "1" });
  if (typeof window !== "undefined" && /^https?:\/\//.test(window.location.origin)) query.set("matrix_parent_origin", window.location.origin);
  return `${endpoint.appBase}/viewer/?${query}`;
}
export function browserViewerMessage(value: unknown): boolean | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  let count = 0;
  for (const key in value) if (!Object.hasOwn(value, key) || ++count > 2 || !["type", "connected"].includes(key)) return null;
  const message = value as Record<string, unknown>;
  return count === 2 && message.type === "matrix-browser-viewer" && typeof message.connected === "boolean" ? message.connected : null;
}
export async function browserRequest(appBase: string, endpoint: string, signal: AbortSignal, body?: object): Promise<unknown> {
  const response = await fetch(`${appBase}/api/${endpoint}`, {
    method: body ? "POST" : "GET", credentials: "include", cache: "no-store", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Browser request unavailable"); }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 8192 || chunks.length >= 64) { await reader.cancel(); throw new Error("Browser response too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally { reader.releaseLock(); }
}
