import type { Dispatcher } from "undici";
import { isIP } from "node:net";
import { isPrivateIp } from "@matrix-os/kernel/security/ssrf-guard";
import type { PlatformDB } from "../db.js";
import type { HetznerClient } from "../customer-vps-hetzner.js";
import { buildPlatformVerificationToken } from "../platform-token.js";
import type { PreviewPairReadinessMember } from "./readiness.js";
import { PreviewPairConflictError } from "./repository.js";
import { readCanonicalPreviewPairMember } from "./runtime-binding.js";
export interface PreviewPairHostTransportOptions {
  db: PlatformDB; provider: HetznerClient; previewSecret: string; controlSecret: string;
  dispatcher: Dispatcher; fetchImpl?: typeof fetch; now: () => number;
}
/** Internal fixed-route transport, independently provider-bound and literal-IP
 * dialed. Callers own body bounds/cancellation and the final canonical fence. */
export function createPreviewPairHostRequester(options: PreviewPairHostTransportOptions) {
  if (options.previewSecret.length < 32 || options.controlSecret.length < 32
    || options.previewSecret === options.controlSecret) throw new PreviewPairConflictError();
  return async (member: PreviewPairReadinessMember, path: string, init: RequestInit, signal: AbortSignal) => {
    const method = init.method ?? "GET";
    if (!(path === "/api/system/info" && method === "GET"
      || path === "/api/internal/platform-funded-ai/config" && ["GET", "POST"].includes(method))
      || method === "GET" && init.body !== undefined && init.body !== null
      || method === "POST" && (typeof init.body !== "string" || Buffer.byteLength(init.body) > 4096)) throw new PreviewPairConflictError();
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000), ...(init.signal ? [init.signal] : [])]);
    deadline.throwIfAborted();
    const { row, candidate } = await readCanonicalPreviewPairMember(options.db, member, options.now);
    const serverId = Number(row.hetzner_server_id);
    if (!options.provider.withSignal || !Number.isSafeInteger(serverId) || serverId <= 0 || !row.public_ipv4
      || isIP(row.public_ipv4) !== 4 || isPrivateIp(row.public_ipv4)) throw new PreviewPairConflictError();
    const server = await options.provider.withSignal(deadline).getServer(serverId);
    if (!server || server.id !== serverId || server.status !== "running" || server.publicIPv4 !== row.public_ipv4
      || server.labels?.app !== "matrix-os" || server.labels.machine_id !== member.machineId
      || server.labels.clerk_user_id !== member.actorId || server.labels.runtime_slot !== member.handle) throw new PreviewPairConflictError();
    deadline.throwIfAborted();
    const response = await (options.fetchImpl ?? fetch)(`https://${row.public_ipv4}:443${path}`, {
      method, ...(method === "POST" ? { body: init.body } : {}),
      headers: { authorization: `Bearer ${buildPlatformVerificationToken(member.handle, options.previewSecret)}`,
        ...(method === "POST" ? { "content-type": "application/json" } : {}) },
      redirect: "error", cache: "no-store", signal: deadline, dispatcher: options.dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
    return { response, row, candidate };
  };
}

export function createPreviewPairAiHostRequester(options: PreviewPairHostTransportOptions) {
  const request = createPreviewPairHostRequester(options);
  return async (member: PreviewPairReadinessMember, init: RequestInit, signal: AbortSignal) =>
    (await request(member, "/api/internal/platform-funded-ai/config", init, signal)).response;
}
