import { isPrivatePreviewHandle, MatrixComputerListSchema, type MatrixComputer, type MatrixComputerList } from "@matrix-os/contracts";
import { z } from "zod/v4";

const TIMEOUT_MS = 10_000;
const BODY_LIMIT = 64 * 1024;
const LEASE_MS = 72 * 60 * 60 * 1000;
const PrivatePreviewListSchema = z.object({
  privatePreviews: z.array(z.object({
    machineId: z.uuid(),
    handle: z.string().max(63).refine(isPrivatePreviewHandle),
    pr: z.number().int().min(1).max(999_999_999),
    confirmedBundleVersion: z.string().max(160).nullable(),
    status: z.string().min(1).max(32),
    provisionedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime().nullable(),
  }).strict()).max(50),
}).strict();

type PrivateInventory = { state: "available"; computers: MatrixComputer[]; expiresAtBySlot: Record<string, number> }
  | { state: "unavailable" | "unauthorized"; computers: [] };

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get("content-length")) > BODY_LIMIT) throw new Error("private inventory too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const abort = () => {
    void reader.cancel().catch((err: unknown) => console.warn("[auth] private inventory cancellation failed:", err instanceof Error ? err.name : typeof err));
  };
  signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  let text = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) return text + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > BODY_LIMIT) {
        await reader.cancel();
        throw new Error("private inventory too large");
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** Compatibility discovery through the existing owner/member endpoint, never authorization. */
export async function fetchOwnerPrivateComputers(options: {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  platformHost: string;
  accessToken: string;
  now: () => number;
}): Promise<PrivateInventory> {
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await options.fetchFn(new URL("/api/private-previews", options.platformHost).toString(), {
      method: "GET",
      headers: { authorization: `Bearer ${options.accessToken}` },
      redirect: "error",
      signal,
    });
    if (response.status === 401) return { state: "unauthorized", computers: [] };
    if (!response.ok) {
      console.warn("[auth] private computer inventory unavailable:", "http rejection");
      return { state: "unavailable", computers: [] };
    }
    const rows = PrivatePreviewListSchema.parse(JSON.parse(await readBody(response, signal))).privatePreviews;
    const now = options.now();
    const computers: MatrixComputer[] = [];
    const expiresAtBySlot: Record<string, number> = {};
    for (const row of rows) {
      const provisionedAt = Date.parse(row.provisionedAt);
      const expiresAt = row.expiresAt ? Date.parse(row.expiresAt) : Number.NaN;
      if (row.status !== "running" || row.handle.split("-")[1] !== String(row.pr)
        || provisionedAt > now || expiresAt <= now || expiresAt !== provisionedAt + LEASE_MS) continue;
      // Derive every routable value from the validated handle. No upstream URL,
      // UUID, bundle text or owner metadata enters the renderer projection.
      computers.push({
        handle: row.handle, runtimeSlot: row.handle, label: "Preview Computer",
        availability: "available", kind: "preview",
        gatewayPath: `/vm/${row.handle}?runtime=${row.handle}`, capabilities: [],
      });
      expiresAtBySlot[row.handle] = Math.min(expiresAtBySlot[row.handle] ?? expiresAt, expiresAt);
    }
    return { state: "available", computers, expiresAtBySlot };
  } catch (err: unknown) {
    console.warn("[auth] private computer inventory unavailable:", err instanceof Error ? err.name : typeof err);
    return { state: "unavailable", computers: [] };
  }
}

/** Customer slots are arbitrary slugs. Positive fresh canonical proof can
 * distinguish a customer slot from a private target; missing proof never can. */
export async function fetchCanonicalCustomerHandle(options: {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  platformHost: string;
  accessToken: string;
  slot: string;
}): Promise<string | null> {
  try {
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const response = await options.fetchFn(new URL("/api/auth/computers", options.platformHost).toString(), {
      method: "GET", headers: { authorization: `Bearer ${options.accessToken}` }, redirect: "error", signal,
    });
    if (!response.ok) {
      console.warn("[auth] customer slot proof unavailable:", "http rejection");
      return null;
    }
    const canonical = MatrixComputerListSchema.parse(JSON.parse(await readBody(response, signal)));
    return canonical.items.find((item) => item.runtimeSlot === options.slot && item.kind === "customer"
      && !isPrivatePreviewHandle(item.handle) && item.availability === "available")?.handle ?? null;
  } catch (err: unknown) {
    console.warn("[auth] customer slot proof unavailable:", err instanceof Error ? err.name : typeof err);
    return null;
  }
}

/** A failed refresh must not retain private entries from an earlier admission. */
export function supplementPrivateComputers(
  canonical: MatrixComputerList,
  privateComputers: MatrixComputer[],
  profileSlot: string | undefined,
): MatrixComputerList {
  const items = canonical.items.filter((item) => (
    !isPrivatePreviewHandle(item.handle) && (!isPrivatePreviewHandle(item.runtimeSlot) || item.kind === "customer")
  ) || privateComputers.some((candidate) => item.handle === candidate.handle && item.runtimeSlot === candidate.runtimeSlot));
  for (const item of privateComputers) {
    if (!items.some((candidate) => candidate.runtimeSlot === item.runtimeSlot)) items.push(item);
  }
  const selectedSlot = [canonical.selectedSlot, profileSlot && isPrivatePreviewHandle(profileSlot) ? profileSlot : null]
    .find((slot) => slot && items.some((item) => item.runtimeSlot === slot)) ?? null;
  const selected = items.find((item) => item.runtimeSlot === selectedSlot);
  const remaining = items.filter((item) => item !== selected);
  // Fresh owner-private choices must survive a full canonical page. The
  // selected computer wins at limit1; other canonical choices keep their order.
  const freshPrivate = remaining.filter((item) => privateComputers.some((candidate) => candidate.runtimeSlot === item.runtimeSlot));
  const ordered = [...(selected ? [selected] : []), ...freshPrivate, ...remaining.filter((item) => !freshPrivate.includes(item))];
  return {
    items: ordered.slice(0, canonical.limit), selectedSlot,
    limit: canonical.limit, hasMore: canonical.hasMore || ordered.length > canonical.limit,
  };
}
