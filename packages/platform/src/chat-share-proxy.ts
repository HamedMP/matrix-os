import { ShareSnapshotSchema, shareHtml } from "@matrix-os/contracts";
import type { Context } from "hono";
import type { Agent } from "undici";
import { getActiveUserMachineByHandle, type PlatformDB } from "./db.js";
import { buildCustomerVpsProxyUrl, isCustomerVpsProxyMachineRoutable } from "./profile-routing.js";
import { createBoundedRateLimiter, runtimeSelectionSourceKey } from "./request-admission.js";

const SHARE_ROUTE = /^\/shared\/chat\/([a-z0-9][a-z0-9-]{0,62})\/([A-Za-z0-9_-]{1,64})\/([a-f0-9]{64})$/;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
let inFlight = 0;
let windowStartedAt = 0;
let attempts = 0;
// Keep one reader below the gateway's per-transport ceiling: all relayed
// readers can share the platform's egress address at the customer VPS.
const sourceLimiter = createBoundedRateLimiter(30);
// At most 16 keys can be active, enforced by the global concurrency ceiling.
// Entries are removed in finally when their last request finishes.
const sourceFlights = new Map<string, number>();

export function parseChatShareRoute(path: string) {
  const match = SHARE_ROUTE.exec(path);
  return match ? { handle: match[1]!, runtimeSlot: match[2]!, token: match[3]! } : null;
}

export async function proxyChatShare(c: Context, db: PlatformDB, dispatcher: Agent, edgeSecret?: string) {
  c.header("Cache-Control", "no-store");
  c.header("CDN-Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  const route = parseChatShareRoute(c.req.path);
  if (!route || c.req.method !== "GET") return c.text("Shared Chat unavailable", 404);
  const source = runtimeSelectionSourceKey(c, edgeSecret);
  if (!sourceLimiter.check(source) || (sourceFlights.get(source) ?? 0) >= 2) return c.text("Try again later", 429);
  if (Date.now() - windowStartedAt >= 60_000) { windowStartedAt = Date.now(); attempts = 0; }
  if (++attempts > 1200 || inFlight >= 16) return c.text("Try again later", 429);
  inFlight += 1;
  sourceFlights.set(source, (sourceFlights.get(source) ?? 0) + 1);
  try {
    const machine = await getActiveUserMachineByHandle(db, route.handle, route.runtimeSlot);
    if (!machine || !isCustomerVpsProxyMachineRoutable(machine)) return c.text("Shared Chat unavailable", 404);
    // Address comes from the operator-controlled machine registry, never a request URL.
    const url = buildCustomerVpsProxyUrl(machine, `/api/share/chats/${route.token}`, "");
    if (!url) return c.text("Shared Chat unavailable", 404);
    const response = await fetch(url, {
      method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000), dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return c.text("Shared Chat unavailable", response.status === 404 ? 404 : 503);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_HTML_BYTES) {
          await reader.cancel();
          return c.text("Shared Chat unavailable", 503);
        }
        chunks.push(chunk.value);
      }
    } finally { reader.releaseLock(); }
    return c.html(shareHtml(ShareSnapshotSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
  } catch (error: unknown) {
    console.warn("[chat-share] unavailable", error instanceof Error ? error.name : "UnknownError");
    return c.text("Shared Chat unavailable", 503);
  } finally {
    inFlight -= 1;
    const remaining = (sourceFlights.get(source) ?? 1) - 1;
    if (remaining) sourceFlights.set(source, remaining);
    else sourceFlights.delete(source);
  }
}
