// This Mac's tailnet peers from the local `tailscale status --json` (spec
// 2706 layer 7), for one-click Add machine. Only names, OS and online state
// are read; the CLI runs with a timeout and a capped output.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod/v4";
import type { TailscalePeer } from "../../shared/local-terminals";
import { describeError } from "./describe-error";

const STATUS_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_PEERS = 256;
const CANDIDATES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];
const UNSAFE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const DNS_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const StatusSchema = z.object({
  BackendState: z.string().max(32),
  Peer: z.record(z.string(), z.unknown()).nullable().optional(),
});
const PeerSchema = z.object({
  HostName: z.string().max(256).catch(""),
  DNSName: z.string().max(260),
  OS: z.string().max(64).catch(""),
  Online: z.boolean().catch(false),
  sshHostKeys: z.array(z.unknown()).max(64).nullable().optional().catch(null),
});

export type TailscalePeersResult = { status: "ready"; peers: TailscalePeer[] } | { status: "missing" | "stopped" | "logged-out" | "unavailable" };

/** The tailscale CLI on this Mac, or null. */
export function findTailscale(exists: (path: string) => boolean = existsSync): string | null {
  return CANDIDATES.find((candidate) => exists(candidate)) ?? null;
}

export function parseTailscaleStatus(raw: string): TailscalePeersResult {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    return { status: "unavailable" };
  }
  const status = StatusSchema.safeParse(parsed);
  if (!status.success) return { status: "unavailable" };
  if (status.data.BackendState === "NeedsLogin" || status.data.BackendState === "NoState") return { status: "logged-out" };
  if (status.data.BackendState !== "Running") return { status: "stopped" };
  const peers: TailscalePeer[] = [];
  for (const raw of Object.values(status.data.Peer ?? {})) {
    const peer = PeerSchema.safeParse(raw);
    if (!peer.success) continue;
    const dnsName = peer.data.DNSName.replace(/\.$/, "");
    if (!DNS_NAME.test(dnsName) || dnsName.length > 253) continue;
    peers.push({
      name: (peer.data.HostName.replace(UNSAFE, "").trim() || dnsName.split(".")[0]!).slice(0, 64),
      dnsName,
      os: peer.data.OS.replace(UNSAFE, "").slice(0, 32),
      online: peer.data.Online,
      tailscaleSsh: (peer.data.sshHostKeys?.length ?? 0) > 0,
    });
    if (peers.length >= MAX_PEERS) break;
  }
  peers.sort((left, right) => Number(right.online) - Number(left.online) || left.name.localeCompare(right.name));
  return { status: "ready", peers };
}

export function tailscalePeers(binary: string | null = findTailscale()): Promise<TailscalePeersResult> {
  if (!binary) return Promise.resolve({ status: "missing" });
  return new Promise((resolve) => {
    execFile(binary, ["status", "--json"], { timeout: STATUS_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
      // A stopped daemon exits non-zero but may still print its state.
      if (error && !stdout) {
        console.warn("[local-terminals] tailscale status failed:", describeError(error));
        resolve({ status: "stopped" });
        return;
      }
      resolve(parseTailscaleStatus(String(stdout)));
    });
  });
}
