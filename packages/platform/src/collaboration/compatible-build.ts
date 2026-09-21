/** Fresh installed-build proof before an operator may request compatible-direct rollback. */
import { COLLABORATION_DIRECT_PROTOCOL_VERSION } from "@matrix-os/contracts";
import { isIP } from "node:net";
import { z } from "zod/v4";
import { buildPlatformVerificationToken } from "../platform-token.js";

const UUID = z.uuid();
const SHA256 = z.string().regex(/^[a-f0-9]{64}$/);
const COMMIT = z.string().regex(/^[a-f0-9]{40}$/);
const VERSION = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const MAX_INFO_BYTES = 32 * 1024;
const SystemInfoProof = z.object({
  runtime: z.object({ machineId: UUID }),
  capabilities: z.object({
    collaboration: z.literal(true),
    collaborationDirectProtocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  }),
  release: z.object({ version: VERSION, gitCommit: COMMIT, sha256: SHA256 }),
});

interface EnrolledMachine {
  machineId: string;
  clerkUserId: string;
  handle: string;
  publicIPv4: string | null;
  status: string;
}

async function readBoundedInfo(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!response.body || (Number.isFinite(declared) && declared > MAX_INFO_BYTES)) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_INFO_BYTES) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-cutover] build proof body unavailable", error instanceof Error ? error.name : "UnknownError");
    return null;
  } finally {
    await reader.cancel().catch((error: unknown) => {
      console.warn("[collaboration-cutover] build proof response drain failed", error instanceof Error ? error.name : "UnknownError");
    });
    reader.releaseLock();
  }
}

export function createCompatibleDirectBuildVerifier(options: {
  resolveMachine(machineId: string): Promise<EnrolledMachine | null | undefined>;
  getPublishedRelease(version: string): Promise<{ version: string; gitCommit: string; sha256: string } | null | undefined>;
  fetchImpl?: typeof fetch;
  platformSecret: string;
}) {
  return async (input: { scopeId: string; runtimeId: string; ownerId: string; targetGeneration: number }): Promise<boolean> => {
    const match = /^vps:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(input.runtimeId);
    if (!match || !UUID.safeParse(input.scopeId).success
      || !Number.isSafeInteger(input.targetGeneration) || input.targetGeneration < 1
      || !options.platformSecret) return false;
    try {
      const machine = await options.resolveMachine(match[1]!);
      if (!machine || machine.machineId !== match[1] || machine.clerkUserId !== input.ownerId
        || machine.status !== "running" || !machine.publicIPv4 || isIP(machine.publicIPv4) !== 4) return false;
      const response = await (options.fetchImpl ?? fetch)(`https://${machine.publicIPv4}:443/api/system/info`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}`,
          host: "app.matrix-os.com",
          "x-forwarded-host": "app.matrix-os.com",
          "x-forwarded-proto": "https",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return false;
      }
      const parsed = SystemInfoProof.safeParse(await readBoundedInfo(response));
      if (!parsed.success || parsed.data.runtime.machineId !== machine.machineId) return false;
      const published = await options.getPublishedRelease(parsed.data.release.version);
      return Boolean(published && published.version === parsed.data.release.version
        && published.gitCommit === parsed.data.release.gitCommit
        && published.sha256 === parsed.data.release.sha256);
    } catch (error: unknown) {
      console.warn("[collaboration-cutover] installed build verification unavailable", error instanceof Error ? error.name : "UnknownError");
      return false;
    }
  };
}
