import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { AgentConfigError } from "./errors.js";

type ResolvedAddress = { address: string; family: number };

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 0 || b === 168)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase().split("%", 1)[0] ?? "";
  if (normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || /^fe[89ab]/.test(normalized)
    || normalized.startsWith("ff")
    || normalized.startsWith("2001:db8");
}

function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !isPrivateIpv4(address);
  if (family === 6) return !isPrivateIpv6(address);
  return false;
}

export async function validateProviderBaseUrl(
  value: string,
  resolveHost: (hostname: string) => Promise<ResolvedAddress[]> = (hostname) =>
    lookup(hostname, { all: true, verbatim: true }),
): Promise<void> {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new AgentConfigError("agent_config_invalid", error);
  }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:"
    || url.username !== ""
    || url.password !== ""
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")) {
    throw new AgentConfigError("agent_config_invalid");
  }
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) {
    throw new AgentConfigError("agent_config_invalid");
  }

  const timeout = AbortSignal.timeout(2_000);
  let addresses: ResolvedAddress[];
  try {
    addresses = await Promise.race([
      resolveHost(hostname),
      new Promise<never>((_resolve, reject) => {
        timeout.addEventListener("abort", () => reject(timeout.reason), { once: true });
      }),
    ]);
  } catch (error) {
    throw new AgentConfigError("agent_config_invalid", error);
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new AgentConfigError("agent_config_invalid");
  }
  // Hermes resolves and follows the configured URL later, so this preflight
  // cannot pin DNS or validate runtime redirects. The residual rebinding risk
  // stays documented until Hermes exposes a pinned-dispatcher policy.
}
