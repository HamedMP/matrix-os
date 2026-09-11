import { z } from "zod/v4";
import {
  type CanonicalChatApprovalDecision,
  type CanonicalOwnerScope,
} from "@matrix-os/contracts";
import {
  CanonicalProviderRunEventSchema,
  type CanonicalProviderRunEvent,
} from "./provider-adapter.js";
import type { HermesStdioClient } from "./hermes-stdio-client.js";

const HermesApprovalChoiceSchema = z.enum(["once", "session", "always", "deny"]);
export const HermesApprovalRequestSchema = z.object({
  request_id: z.string().min(1).max(256).optional(),
  choices: z.array(HermesApprovalChoiceSchema).min(1).max(4).optional(),
  smart_denied: z.boolean().optional(),
  allow_session: z.boolean().optional(),
  allow_permanent: z.boolean().optional(),
}).passthrough();
const HermesApprovalResponseSchema = z.object({ resolved: z.literal(true) }).passthrough();

type HermesApprovalRequest = z.infer<typeof HermesApprovalRequestSchema>;
type ApprovalEvent = Extract<CanonicalProviderRunEvent, { type: "approval.requested" | "approval.resolved" }>;

interface PendingApproval {
  requestId?: string;
  allowedDecisions: CanonicalChatApprovalDecision[];
}

interface ResolvedApproval {
  clientRequestId: string;
  decision: CanonicalChatApprovalDecision;
}

interface InFlightApproval extends ResolvedApproval {
  completion: Promise<void>;
}

interface ActiveHermesRun {
  owner: CanonicalOwnerScope;
  chatId: string;
  client: HermesStdioClient;
  liveSessionId: string;
  emit(event: ApprovalEvent): void;
  pending: Map<string, PendingApproval>;
  inFlight: Map<string, InFlightApproval>;
  resolved: Map<string, ResolvedApproval>;
}

const MAX_ACTIVE_RUNS = 128;
const MAX_PENDING_APPROVALS_PER_RUN = 16;
const MAX_RESOLVED_APPROVALS_PER_RUN = 32;

function approvalChoices(request: HermesApprovalRequest): z.infer<typeof HermesApprovalChoiceSchema>[] {
  if (request.choices) return request.choices;
  if (request.smart_denied) return ["once", "deny"];
  const choices: z.infer<typeof HermesApprovalChoiceSchema>[] = ["once"];
  if (request.allow_session !== false) {
    choices.push("session");
    if (request.allow_permanent !== false) choices.push("always");
  }
  choices.push("deny");
  return choices;
}

function canonicalDecisions(request: HermesApprovalRequest): CanonicalChatApprovalDecision[] {
  const decisions: CanonicalChatApprovalDecision[] = [];
  for (const choice of approvalChoices(request)) {
    const decision = choice === "once"
      ? "approve" as const
      : choice === "session"
        ? "approve_for_session" as const
        : choice === "deny" ? "decline" as const : undefined;
    if (decision && !decisions.includes(decision)) decisions.push(decision);
  }
  return decisions;
}

function nativeChoice(decision: CanonicalChatApprovalDecision): "once" | "session" | "deny" | undefined {
  if (decision === "approve") return "once";
  if (decision === "approve_for_session") return "session";
  if (decision === "decline") return "deny";
  return undefined;
}

function sameOwner(left: CanonicalOwnerScope, right: CanonicalOwnerScope): boolean {
  return left.type === right.type && left.ownerId === right.ownerId;
}

function setBounded<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (!map.has(key) && map.size >= maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function createHermesApprovalController() {
  const active = new Map<string, ActiveHermesRun>();

  return {
    registerRun(input: {
      owner: CanonicalOwnerScope;
      chatId: string;
      runId: string;
      client: HermesStdioClient;
      liveSessionId: string;
      emit(event: ApprovalEvent): void;
    }): () => void {
      if (!active.has(input.runId) && active.size >= MAX_ACTIVE_RUNS) {
        throw new Error("Hermes active Run limit exceeded");
      }
      const run: ActiveHermesRun = {
        ...input,
        pending: new Map(),
        inFlight: new Map(),
        resolved: new Map(),
      };
      active.set(input.runId, run);
      return () => {
        if (active.get(input.runId) === run) active.delete(input.runId);
      };
    },

    registerRequest(runId: string, approvalId: string, request: HermesApprovalRequest): ApprovalEvent {
      const run = active.get(runId);
      if (!run) throw new Error("Hermes approval Run unavailable");
      const allowedDecisions = canonicalDecisions(request);
      if (allowedDecisions.length === 0) throw new Error("Hermes approval choices unsupported");
      if (!run.pending.has(approvalId) && run.pending.size >= MAX_PENDING_APPROVALS_PER_RUN) {
        throw new Error("Hermes pending approval limit exceeded");
      }
      run.pending.set(approvalId, {
        ...(request.request_id ? { requestId: request.request_id } : {}),
        allowedDecisions,
      });
      return CanonicalProviderRunEventSchema.parse({
        type: "approval.requested",
        approvalId,
        title: "Command approval required",
        risk: "high",
        allowedDecisions,
      }) as ApprovalEvent;
    },

    async submit(input: {
      owner: CanonicalOwnerScope;
      chatId: string;
      runId: string;
      approvalId: string;
      decision: CanonicalChatApprovalDecision;
      clientRequestId: string;
    }): Promise<void> {
      const run = active.get(input.runId);
      if (!run || run.chatId !== input.chatId || !sameOwner(run.owner, input.owner)) {
        throw new Error("Hermes approval Run unavailable");
      }
      const resolved = run.resolved.get(input.approvalId);
      if (resolved) {
        if (resolved.clientRequestId === input.clientRequestId && resolved.decision === input.decision) return;
        throw new Error("Hermes approval already resolved");
      }
      const inFlight = run.inFlight.get(input.approvalId);
      if (inFlight) {
        if (inFlight.clientRequestId === input.clientRequestId && inFlight.decision === input.decision) {
          return inFlight.completion;
        }
        throw new Error("Hermes approval already resolving");
      }
      const pending = run.pending.get(input.approvalId);
      const choice = nativeChoice(input.decision);
      if (!pending || !choice || !pending.allowedDecisions.includes(input.decision)) {
        throw new Error("Hermes approval decision unavailable");
      }
      const receipt = {
        clientRequestId: input.clientRequestId,
        decision: input.decision,
      };
      const completion = (async () => {
        HermesApprovalResponseSchema.parse(await run.client.request("approval.respond", {
          session_id: run.liveSessionId,
          ...(pending.requestId ? { request_id: pending.requestId } : {}),
          choice,
        }));
        run.pending.delete(input.approvalId);
        setBounded(run.resolved, input.approvalId, receipt, MAX_RESOLVED_APPROVALS_PER_RUN);
        run.emit(CanonicalProviderRunEventSchema.parse({
          type: "approval.resolved",
          approvalId: input.approvalId,
          decision: input.decision,
        }) as ApprovalEvent);
      })();
      const activeSubmission = { ...receipt, completion };
      run.inFlight.set(input.approvalId, activeSubmission);
      try {
        await completion;
      } finally {
        if (run.inFlight.get(input.approvalId) === activeSubmission) {
          run.inFlight.delete(input.approvalId);
        }
      }
    },
  };
}
