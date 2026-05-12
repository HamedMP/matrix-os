import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { UserMachineRecord } from "./db.js";

const HANDOFF_AUDIENCE = "matrix-browser-handoff";
const HANDOFF_ISSUER = "matrix-os-platform";

export function normalizeBrowserHandoffTarget(path: string): string {
  const raw = path.replace(/^\/browser\/?/, "").trim();
  if (!raw || raw === "about:blank") return "about:blank";
  try {
    if (/^https?:\/\//i.test(raw)) {
      return new URL(raw).toString();
    }
    return new URL(`https://${raw}`).toString();
  } catch (error: unknown) {
    console.warn("[browser-handoff] Invalid target path:", error instanceof Error ? error.message : String(error));
    return "about:blank";
  }
}

export function browserHandoffPathWithTargetQuery(path: string, rawUrl: string): string {
  const url = new URL(rawUrl);
  const targetQuery = new URLSearchParams(url.search);
  targetQuery.delete("deviceId");
  targetQuery.delete("handoff");
  const suffix = targetQuery.toString();
  return suffix ? `${path}?${suffix}` : path;
}

export function buildBrowserHandoffRedirectUrl(opts: {
  machine: Pick<UserMachineRecord, "publicIPv4" | "status">;
  targetPath: string;
  token: string;
  ownerHostAllowlist?: string[];
}): string | null {
  if (opts.machine.status !== "running" || !opts.machine.publicIPv4) return null;
  if (!isBrowserOwnerHostAllowed(opts.machine.publicIPv4, opts.ownerHostAllowlist ?? [])) return null;
  const target = opts.targetPath.replace(/^\/browser\/?/, "");
  const url = new URL(`/browser/${target}`, `https://${opts.machine.publicIPv4}`);
  url.searchParams.set("handoff", opts.token);
  return url.toString();
}

export function isBrowserOwnerHostAllowed(host: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return normalized === allowed || (allowed.startsWith("*.") && normalized.endsWith(allowed.slice(1)));
  });
}

export async function signPlatformBrowserHandoff(opts: {
  privateKeyPem: string;
  keyId: string;
  ownerId: string;
  deviceId: string;
  target: string;
  now?: number;
  ttlSeconds?: number;
}): Promise<string> {
  const key = await importPKCS8(opts.privateKeyPem.replaceAll("\\n", "\n"), "RS256");
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000);
  return new SignJWT({
    ownerId: opts.ownerId,
    deviceId: opts.deviceId,
    target: opts.target,
    nonce: randomUUID(),
  })
    .setProtectedHeader({ alg: "RS256", kid: opts.keyId, typ: "JWT" })
    .setIssuer(HANDOFF_ISSUER)
    .setAudience(HANDOFF_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + (opts.ttlSeconds ?? 60))
    .sign(key);
}
