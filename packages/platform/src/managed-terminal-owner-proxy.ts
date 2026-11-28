import { CanonicalCancelChatRunRequestSchema, CanonicalChatIdSchema, CanonicalChatRunIdSchema } from "@matrix-os/contracts";
import type { PlatformDB, UserMachineRecord } from "./db.js";
import { managedTerminalCanaryFromEnv, matchesManagedTerminalCanaryMachine } from "./managed-terminal-canary.js";
import { createManagedTerminalGrantClaims } from "./managed-terminal-grant-claims.js";
import { authenticatedManagedTerminalProxyProof } from "./managed-terminal-owner-proof.js";
import { readRoutineProofProxyBody } from "./routine-proof-proxy-body.js";
import type { AppDomainIdentity } from "./session-routing-identity.js";

const CANCEL = /^\/api\/chats\/([^/]+)\/runs\/([^/]+)\/cancel$/;

/** Platform participates only in the existing Web Chat send and Stop surface. */
export function createManagedTerminalOwnerProxy(options: { db: PlatformDB; env: NodeJS.ProcessEnv; platformSecret: string }) {
  const grants = createManagedTerminalGrantClaims(options.db);
  return async (input: {
    request: Request; method: string; path: string; machine: UserMachineRecord; identity: AppDomainIdentity;
  }): Promise<string | null | { status: 400 | 408 | 413 | 503 }> => {
    if (options.env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED !== "1" || input.method !== "POST") return null;
    const canary = managedTerminalCanaryFromEnv(options.env, Date.now());
    if (canary === null) return null;
    const cancel = CANCEL.exec(input.path);
    if (!cancel) return authenticatedManagedTerminalProxyProof({ ...input, canary, platformSecret: options.platformSecret });
    const { identity, machine } = input;
    if (identity.source !== "auth" || identity.sessionProvenance !== "clerk-browser"
      || (identity.verifiedHumanBrowserExpiresAt ?? 0) * 1000 <= Date.now()
      || identity.userId !== machine.clerkUserId || machine.accessClerkUserIds.length !== 0
      || (machine.provisioningClass !== "private-preview" && machine.provisioningClass !== "customer")
      || input.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
      || new URL(input.request.url).searchParams.has("token")) return null;
    const chat = CanonicalChatIdSchema.safeParse(cancel[1]);
    const run = CanonicalChatRunIdSchema.safeParse(cancel[2]);
    if (!chat.success || !run.success || (canary && (chat.data !== canary.chatId
      || !matchesManagedTerminalCanaryMachine(machine, canary.source)))) return null;
    const raw = await readRoutineProofProxyBody(input.request, 4 * 1024);
    if (typeof raw !== "string") return raw;
    try {
      if (!CanonicalCancelChatRunRequestSchema.safeParse(JSON.parse(raw)).success) return { status: 400 };
      if (canary && canary.expiresAt <= Date.now()) return null;
      await grants.revoke({
        ownerId: machine.clerkUserId, sourceMachineId: machine.machineId,
        sourceRuntimeSlot: machine.runtimeSlot, sourceEpoch: machine.runtimeTokenEpoch,
      }, chat.data, run.data);
      return null;
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return { status: 400 };
      console.warn("[terminal-control] Grant revocation unavailable", error instanceof Error ? error.name : "UnknownError");
      return { status: 503 };
    }
  };
}
