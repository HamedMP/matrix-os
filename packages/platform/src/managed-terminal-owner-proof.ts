import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod/v4";
import { canonicalPreviewDriveTurnBody, CanonicalCreateChatTurnRequestSchema, TerminalRefSchema } from "@matrix-os/contracts";
import { isTerminalControlCommand } from "@matrix-os/contracts/herdr-terminals";
import { isManagedTerminalRef, ManagedTerminalRuntimeSchema } from "@matrix-os/contracts/managed-terminal-control";
import { managedTerminalBodyDigest, managedWorkspaceIdFor } from "@matrix-os/contracts/managed-terminal-proof";
import type { UserMachineRecord } from "./db.js";
import { matchesManagedTerminalCanaryMachine, type ManagedTerminalCanary } from "./managed-terminal-canary.js";
import { readRoutineProofProxyBody } from "./routine-proof-proxy-body.js";
import type { AppDomainIdentity } from "./session-routing-identity.js";

const MAX_BODY_BYTES = 128 * 1024;
const ACTIVATION_MS = 60_000;
const GRANT_MS = 15 * 60_000;
const CHAT_TURN_PATH = /^\/api\/chats\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})\/turns$/;
const referenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const payloadSchema = z.strictObject({
  version: z.literal(1),
  ownerId: ManagedTerminalRuntimeSchema.shape.ownerId,
  sourceMachineId: ManagedTerminalRuntimeSchema.shape.machineId,
  sourceRuntimeSlot: ManagedTerminalRuntimeSchema.shape.runtimeSlot,
  sourceEpoch: z.number().int().min(1).max(2_147_483_647),
  chatId: referenceId,
  clientRequestId: referenceId,
  worktreeId: referenceId,
  workspaceId: TerminalRefSchema.shape.workspaceId,
  tabId: TerminalRefSchema.shape.tabId,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  nonce: z.uuidv4(),
  activateBefore: z.number().int(),
  expiresAt: z.number().int(),
}).refine(isManagedTerminalRef);

export type ManagedTerminalOwnerProof = z.infer<typeof payloadSchema>;
type SourceMachine = Pick<UserMachineRecord, "machineId" | "runtimeSlot" | "clerkUserId" | "runtimeTokenEpoch" |
  "activationState" | "status" | "deletedAt" | "provisioningClass" | "accessClerkUserIds">;

function signature(encoded: string, platformSecret: string) {
  return createHmac("sha256", platformSecret).update(`matrix-terminal-control.v1.explicit-owner.${encoded}`).digest();
}

function verifiedOwnerSessionExpiry(identity: AppDomainIdentity, machine: SourceMachine, now: number): number | null {
  const humanExpiry = identity.verifiedHumanBrowserExpiresAt;
  if (identity.source !== "auth" || identity.sessionProvenance !== "clerk-browser"
    || identity.userId !== machine.clerkUserId || humanExpiry === undefined || !Number.isSafeInteger(humanExpiry)
    || (machine.provisioningClass !== "customer" && machine.provisioningClass !== "private-preview")
    || machine.status !== "running" || machine.activationState !== "authorized"
    || machine.deletedAt !== null || machine.accessClerkUserIds.length !== 0) return null;
  const expiry = Math.min(humanExpiry, identity.sessionExpiresAt ?? Infinity) * 1000;
  return expiry > now ? expiry : null;
}

function selectedTerminal(body: z.infer<typeof CanonicalCreateChatTurnRequestSchema>) {
  const invocations = body.parts.filter(part => part.type === "invocation_reference");
  const [invocation] = invocations;
  if (invocations.length !== 1 || !isTerminalControlCommand(invocation?.invocation)) return null;
  const terminals = body.parts.flatMap(part =>
    part.type === "resource_reference" && part.resource.kind === "terminal_session" ? [part.resource] : []);
  const [target] = terminals;
  if (terminals.length !== 1 || !target?.revision) return null;
  const [workspaceId, tabId, ...rest] = target.id.split(":");
  const ref = TerminalRefSchema.safeParse({ workspaceId, tabId });
  if (rest.length || !ref.success || !isManagedTerminalRef(ref.data)) return null;
  return { ...ref.data, revision: target.revision };
}

/**
 * The existing authenticated owner turn supplies the only authority to control a peer.
 * The proxy issues this centrally; machine/runtime proofs cannot mint it.
 */
export async function authenticatedManagedTerminalProxyProof(input: {
  request: Request;
  method: string;
  path: string;
  machine: SourceMachine;
  identity: AppDomainIdentity;
  platformSecret: string;
  canary?: ManagedTerminalCanary;
  now?: number;
  timeoutMs?: number;
}): Promise<string | null | { status: 400 | 408 | 413 | 503 }> {
  const match = CHAT_TURN_PATH.exec(input.path);
  const chatId = match?.[1];
  const now = input.now ?? Date.now();
  const { canary } = input;
  const sessionExpiry = verifiedOwnerSessionExpiry(input.identity, input.machine, now);
  if (!chatId || input.method !== "POST" || input.request.method !== "POST" || !input.platformSecret
    || sessionExpiry === null
    || (canary && (chatId !== canary.chatId || canary.expiresAt <= now
      || !matchesManagedTerminalCanaryMachine(input.machine, canary.source)))
    || input.request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
    || new URL(input.request.url).searchParams.has("token")) return null;

  const raw = await readRoutineProofProxyBody(input.request, MAX_BODY_BYTES, input.timeoutMs);
  if (typeof raw !== "string") return raw;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return { status: 400 };
    throw error;
  }

  const body = CanonicalCreateChatTurnRequestSchema.safeParse(decoded);
  if (!body.success || body.data.permissionMode !== "full_access" || body.data.interactionMode !== "default"
    || body.data.executionRoot?.kind !== "worktree" || body.data.routineCreation) return null;
  const terminal = selectedTerminal(body.data);
  if (!terminal || (canary && (terminal.workspaceId !== managedWorkspaceIdFor(canary.target.machineId)
    || canary.expiresAt <= (input.now ?? Date.now())))) return null;
  // The browser must still be authenticated when the Platform admits the first
  // action. Its short token lifetime does not interrupt an already authorized run.
  const expiresAt = canary ? Math.min(now + GRANT_MS, canary.expiresAt) : now + GRANT_MS;
  const payload = payloadSchema.safeParse({
    ...terminal, version: 1,
    ownerId: input.identity.userId, sourceMachineId: input.machine.machineId, sourceRuntimeSlot: input.machine.runtimeSlot,
    sourceEpoch: input.machine.runtimeTokenEpoch,
    chatId, clientRequestId: body.data.clientRequestId, worktreeId: body.data.executionRoot.worktreeId,
    bodyDigest: managedTerminalBodyDigest(canonicalPreviewDriveTurnBody(body.data)),
    nonce: randomUUID(), activateBefore: Math.min(sessionExpiry, now + ACTIVATION_MS, expiresAt), expiresAt,
  });
  if (!payload.success) return null;
  const encoded = Buffer.from(JSON.stringify(payload.data)).toString("base64url");
  return `${encoded}.${signature(encoded, input.platformSecret).toString("hex")}`;
}

export function verifyManagedTerminalOwnerProof(
  proof: string | null | undefined,
  { platformSecret, now = Date.now() }: { platformSecret: string; now?: number },
): ManagedTerminalOwnerProof | null {
  if (!proof || proof.length > 2048 || !platformSecret) return null;
  const match = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(proof);
  if (!match || !timingSafeEqual(signature(match[1]!, platformSecret), Buffer.from(match[2]!, "hex"))) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")); }
  catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = payloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const { activateBefore, expiresAt } = parsed.data;
  return activateBefore <= expiresAt && activateBefore <= now + ACTIVATION_MS
    && expiresAt > now && expiresAt <= now + GRANT_MS ? parsed.data : null;
}
