import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
const blocked = new BlockList();
for (const [subnet, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24],
  ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(subnet, prefix, "ipv4");
for (const [subnet, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10],
  ["ff00::", 8], ["2001:db8::", 32],
] as const) blocked.addSubnet(subnet, prefix, "ipv6");

function publicAddress(raw: string): boolean {
  const address = raw.startsWith("::ffff:") ? raw.slice(7) : raw;
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Validates the server-issued presigned destination before native network I/O. */
export async function validateDriveTransferUrl(raw: string,
  resolveHost: Resolver = (hostname) => lookup(hostname, { all: true, verbatim: true })): Promise<void> {
  const url = new URL(raw);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password
    || (url.port && url.port !== "443") || url.hash) throw new Error("Unsafe transfer destination");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal")) throw new Error("Unsafe transfer destination");
  if (isIP(hostname)) {
    if (!publicAddress(hostname)) throw new Error("Unsafe transfer destination");
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let addresses: Address[];
  try {
    addresses = await Promise.race([
      resolveHost(hostname),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Transfer DNS timeout")), 10_000);
      }),
    ]);
  } finally { clearTimeout(timer); }
  if (addresses.length < 1 || addresses.length > 20 || addresses.some(({ address }) => !publicAddress(address))) {
    throw new Error("Unsafe transfer destination");
  }
  // Node fetch resolves DNS independently; this preflight cannot pin the checked address.
}
