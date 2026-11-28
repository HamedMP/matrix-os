import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Agent } from "undici";
import {
  MANAGED_TERMINAL_BROKER_PATH,
  MANAGED_TERMINAL_MAX_COMPUTERS,
  MANAGED_TERMINAL_TARGET_PATH,
  ManagedTerminalActionResponseSchema,
  ManagedTerminalBrokerRequestSchema,
  ManagedTerminalComputerSchema,
  MAX_MANAGED_TERMINAL_BODY_BYTES,
  MAX_MANAGED_TERMINAL_RESPONSE_BYTES,
  MAX_MANAGED_TERMINAL_WIRE_BYTES,
  type ManagedTerminalBrokerRequest,
} from "@matrix-os/contracts/managed-terminal-control";
import {
  createManagedTerminalHeaders,
  createManagedTerminalVerifier,
  MANAGED_TERMINAL_NONCE_HEADER,
  MANAGED_TERMINAL_TIMESTAMP_HEADER,
  managedWorkspaceIdFor,
  openManagedTerminalPayload,
  readManagedTerminalResponseText,
  sealManagedTerminalPayload,
  verifyManagedTerminalReply,
} from "@matrix-os/contracts/managed-terminal-proof";
import { HerdrSessionListSchema } from "@matrix-os/contracts/herdr-terminals";
import { getAccountDeletionAdmission } from "./account-deletion/admission.js";
import { getUserMachine, type PlatformDB, type UserMachineRecord } from "./db.js";
import { mapUserMachine } from "./database/user-machine-records.js";
import { managedTerminalCanaryFromEnv, matchesManagedTerminalCanaryMachine, sameManagedTerminalRuntime, type ManagedTerminalCanary } from "./managed-terminal-canary.js";
import { createManagedTerminalGrantClaims } from "./managed-terminal-grant-claims.js";
import { verifyManagedTerminalOwnerProof } from "./managed-terminal-owner-proof.js";
import { buildPlatformSyncVerificationToken } from "./platform-token.js";
import type { PrivatePreviewEligibility } from "./private-preview-eligibility.js";
import { getRuntimeEntitlementDecisionForUser } from "./runtime-entitlement.js";
import { createPlatformSubstrateRegistry } from "./substrates/platform-substrates.js";
import type { SubstrateRegistry } from "./substrates/registry.js";
import { applyUpstreamCredentials, dispatcherForUpstream } from "./substrates/upstream-transport.js";

const TARGET_TIMEOUT_MS = 8_000;

interface ManagedTerminalControlOptions {
  db: PlatformDB;
  platformSecret: string;
  env: NodeJS.ProcessEnv;
  privatePreviewEligibility?: PrivatePreviewEligibility;
  substrates?: SubstrateRegistry;
  dispatcher?: Agent;
  now?: () => number;
}

/** Only Platform's current machine record supplies the destination and authority. */
export function createManagedTerminalControlRoutes(options: ManagedTerminalControlOptions) {
  const app = new Hono();
  const { db, platformSecret, env, dispatcher, privatePreviewEligibility, now = Date.now } = options;
  const substrates = options.substrates ?? createPlatformSubstrateRegistry(db, env);
  const verify = createManagedTerminalVerifier({ direction: "source", now });
  const grants = createManagedTerminalGrantClaims(db, now);

  function identity(machine: UserMachineRecord) {
    return { machineId: machine.machineId, ownerId: machine.clerkUserId, runtimeSlot: machine.runtimeSlot };
  }

  function key(machine: UserMachineRecord) {
    return buildPlatformSyncVerificationToken(machine, platformSecret, machine.runtimeTokenEpoch);
  }

  function eligibleMachine(machine: UserMachineRecord) {
    return machine.deletedAt === null && machine.status === "running"
      && machine.activationState === "authorized" && machine.accessClerkUserIds.length === 0
      && (machine.provisioningClass === "customer" || machine.provisioningClass === "private-preview");
  }

  async function eligible(machine: UserMachineRecord) {
    if (!eligibleMachine(machine)) return false;
    if (machine.provisioningClass === "private-preview" && !await privatePreviewEligibility?.(machine)) return false;
    const access = await getRuntimeEntitlementDecisionForUser(db, machine.clerkUserId, env,
      machine.runtimeSlot, machine.provisioningClass, new Date(now()));
    return access.runtimeProxyAllowed;
  }

  async function readComputers(source: UserMachineRecord, signal: AbortSignal, canary?: ManagedTerminalCanary) {
    let query = db.executor.selectFrom("user_machines").selectAll()
      .where("clerk_user_id", "=", source.clerkUserId)
      .where("provisioning_class", "=", source.provisioningClass)
      .where("status", "=", "running")
      .where("activation_state", "=", "authorized")
      .where("machine_id", "!=", source.machineId)
      .where("deleted_at", "is", null);
    if (canary) query = query.where("machine_id", "=", canary.target.machineId).where("runtime_slot", "=", canary.target.runtimeSlot);
    const rows = await query
      .orderBy("handle", "asc").orderBy("runtime_slot", "asc").orderBy("machine_id", "asc")
      .limit(MANAGED_TERMINAL_MAX_COMPUTERS + 1).execute();
    const computers = [];
    for (const row of rows.slice(0, MANAGED_TERMINAL_MAX_COMPUTERS)) {
      if (signal.aborted) break;
      const machine = mapUserMachine(row);
      if (!await eligible(machine) || resolve(machine).kind !== "upstream") continue;
      const parsed = ManagedTerminalComputerSchema.safeParse({
        machineId: machine.machineId, name: machine.handle, runtimeSlot: machine.runtimeSlot,
      });
      if (parsed.success) computers.push(parsed.data);
    }
    return { computers, partial: rows.length > MANAGED_TERMINAL_MAX_COMPUTERS };
  }

  function resolve(machine: UserMachineRecord) {
    return substrates.resolveUpstream(machine, { path: MANAGED_TERMINAL_TARGET_PATH });
  }

  function unchanged(current: UserMachineRecord | undefined, previous: UserMachineRecord): current is UserMachineRecord {
    return Boolean(current && eligibleMachine(current)
      && current.clerkUserId === previous.clerkUserId && current.handle === previous.handle
      && current.runtimeSlot === previous.runtimeSlot && current.provisioningClass === previous.provisioningClass
      && current.runtimeTokenEpoch === previous.runtimeTokenEpoch && current.generation === previous.generation);
  }

  async function authorizeAction(
    request: Extract<ManagedTerminalBrokerRequest["request"], { kind: "action" }>,
    source: UserMachineRecord,
    target: UserMachineRecord,
    canary?: ManagedTerminalCanary,
  ) {
    const { authority, ...action } = request;
    const grant = verifyManagedTerminalOwnerProof(authority.proof, { platformSecret, now: now() });
    if (!grant || grant.ownerId !== source.clerkUserId || grant.sourceMachineId !== source.machineId
      || grant.sourceRuntimeSlot !== source.runtimeSlot || grant.sourceEpoch !== source.runtimeTokenEpoch
      || grant.chatId !== request.chatId || grant.clientRequestId !== authority.clientRequestId
      || grant.bodyDigest !== authority.bodyDigest
      || grant.worktreeId !== request.worktreeId
      || grant.workspaceId !== managedWorkspaceIdFor(target.machineId)
      || grant.tabId !== request.ref.tabId || grant.revision !== request.revision
      || (canary && (grant.chatId !== canary.chatId || grant.expiresAt > canary.expiresAt || canary.expiresAt <= now()))) return null;
    return await grants.claim({ ...grant, runId: request.runId }) ? action : null;
  }

  app.post(MANAGED_TERMINAL_BROKER_PATH, bodyLimit({
    maxSize: MAX_MANAGED_TERMINAL_BODY_BYTES, onError: c => c.json({ error: "request_too_large" }, 413),
  }), async c => {
    c.header("Cache-Control", "no-store");
    const canary = managedTerminalCanaryFromEnv(env, now());
    if (env.MATRIX_MANAGED_TERMINAL_CONTROL_ENABLED !== "1" || !platformSecret || canary === null) {
      return c.json({ error: "unavailable" }, 404);
    }
    if (new URL(c.req.url).search || c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
      return c.json({ error: "invalid_request" }, 400);
    }
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (error: unknown) {
      if (error instanceof SyntaxError) return c.json({ error: "invalid_request" }, 400);
      throw error;
    }
    const input = ManagedTerminalBrokerRequestSchema.safeParse(json);
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    // Require a machine proof before returning any identity or inventory information.
    const nonce = c.req.header(MANAGED_TERMINAL_NONCE_HEADER);
    const timestamp = c.req.header(MANAGED_TERMINAL_TIMESTAMP_HEADER);
    if (!nonce || !timestamp) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const { source: claimed, request } = input.data;
    if (canary && !sameManagedTerminalRuntime(claimed, canary.source)) return c.json({ error: "forbidden" }, 403);
    const canaryExpired = () => canary !== undefined && canary.expiresAt <= now();
    try {
      const source = await getUserMachine(db, claimed.machineId);
      if (!source || source.clerkUserId !== claimed.ownerId || source.runtimeSlot !== claimed.runtimeSlot
        || (canary && (source.handle !== canary.sourceHandle || !matchesManagedTerminalCanaryMachine(source, canary.source)))) {
        return c.json({ error: "unauthorized" }, 401);
      }
      const proof = verify(c.req.raw, key(source), raw);
      if (!proof) return c.json({ error: "unauthorized" }, 401);
      if (canaryExpired()) return c.json({ error: "unavailable" }, 404);
      const signals = [proof, c.req.raw.signal];
      if (canary) signals.push(AbortSignal.timeout(Math.max(0, canary.expiresAt - now())));
      const signal = AbortSignal.any(signals);
      if (!(await getAccountDeletionAdmission(db, source.clerkUserId, env, new Date(now()))).newWorkAllowed
        || !await eligible(source) || signal.aborted) {
        return c.json({ error: "forbidden" }, 403);
      }
      if (request.kind === "computers") {
        const listed = await readComputers(source, signal, canary);
        if (!unchanged(await getUserMachine(db, source.machineId), source) || signal.aborted || canaryExpired()) {
          return c.json({ error: "unavailable" }, 503);
        }
        return c.json(listed);
      }
      if (canary && request.targetMachineId !== canary.target.machineId) return c.json({ error: "unavailable" }, 404);
      const target = await getUserMachine(db, request.targetMachineId);
      if (!target || target.machineId === source.machineId
        || target.clerkUserId !== source.clerkUserId || target.provisioningClass !== source.provisioningClass
        || (canary && !matchesManagedTerminalCanaryMachine(target, canary.target))
        || !await eligible(target)) {
        return c.json({ error: "unavailable" }, 404);
      }
      // Eligibility can involve awaited membership or billing checks. Re-read
      // after those checks so a replaced or revoked machine cannot inherit them.
      const [sourceNow, targetNow] = await Promise.all([
        getUserMachine(db, source.machineId), getUserMachine(db, target.machineId),
      ]);
      if (!unchanged(sourceNow, source) || !unchanged(targetNow, target)) {
        return c.json({ error: "unavailable" }, 404);
      }
      const resolution = resolve(targetNow);
      if (resolution.kind !== "upstream" || signal.aborted) return c.json({ error: "unavailable" }, 503);
      const { upstream } = resolution;
      const targetRequest = request.kind === "action" ? await authorizeAction(request, sourceNow, targetNow, canary) : request;
      if (!targetRequest || signal.aborted || canaryExpired()) return c.json({ error: "forbidden" }, 403);
      // Preserve the original freshness and unique operation identity across
      // Platform replicas. The target consumes the same nonce on every relay.
      const targetKey = key(targetNow);
      const issuedAt = Number(timestamp);
      const body = sealManagedTerminalPayload(targetKey, "target",
        JSON.stringify({ source: identity(sourceNow), target: identity(targetNow), request: targetRequest }));
      const headers = new Headers(createManagedTerminalHeaders(targetKey, "target", body, { issuedAt, nonce }));
      headers.set("host", upstream.hostHeader);
      applyUpstreamCredentials(headers, upstream);
      const response = await fetch(upstream.url, {
        method: "POST", headers, body, redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TARGET_TIMEOUT_MS)]),
        ...(dispatcher ? { dispatcher: dispatcherForUpstream(upstream, dispatcher) } : {}),
      } as RequestInit);
      if ((!response.ok && response.status !== 409) || signal.aborted || canaryExpired()) {
        await response.body?.cancel();
        return c.json({ error: "unavailable" }, 409);
      }
      const reply = await readManagedTerminalResponseText(response, MAX_MANAGED_TERMINAL_WIRE_BYTES);
      if (signal.aborted || canaryExpired()) return c.json({ error: "unavailable" }, 409);
      if (!verifyManagedTerminalReply(targetKey, response, reply, issuedAt, nonce)) {
        return c.json({ error: "unavailable" }, 502);
      }
      const plaintext = openManagedTerminalPayload(targetKey, "target-response", reply);
      if (plaintext === null || Buffer.byteLength(plaintext) > MAX_MANAGED_TERMINAL_RESPONSE_BYTES) {
        return c.json({ error: "unavailable" }, 502);
      }
      const result = JSON.parse(plaintext) as unknown;
      if (response.status === 409) {
        return request.kind === "action" && result !== null && typeof result === "object"
          && "error" in result && result.error === "user_input_required"
          ? c.json({ error: "user_input_required" }, 409)
          : c.json({ error: "unavailable" }, 409);
      }
      const schema = request.kind === "terminals" ? HerdrSessionListSchema : ManagedTerminalActionResponseSchema;
      const parsed = schema.safeParse(result);
      return parsed.success ? c.json(parsed.data) : c.json({ error: "unavailable" }, 502);
    } catch (error: unknown) {
      console.warn("[terminal-control] Managed runtime operation failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ error: "unavailable" }, 503);
    }
  });
  return app;
}
