/**
 * Live bindings for private bot runtimes (spec 536, research R4). A binding
 * ties a scope-runtime handle and generation to the one run it serves: owner,
 * bot, chat, task, run, workspace fingerprint, resolved model route, and the
 * capability set. The broker authorizes every frame against it; a worker can
 * never widen it. Bounded (64) with a TTL sweep before admission, like the
 * shared-AI registry it sits beside.
 */
import { RuntimeHandleSchema } from "@matrix-os/scope-runtime";
import type { ScopeRuntimeBrokerRequest } from "@matrix-os/scope-runtime/broker-protocol";
import {
  BotModelRouteSchema,
  BotToolCapabilitySchema,
  ChatAgentIdSchema,
  type BotModelRoute,
  type BotToolCapability,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import {
  BotCredentialAccessSourceIdSchema,
  type BotCredentialAccessSourceId,
} from "./credentials.js";
import type { BotInferenceAuthorization } from "./credentials.js";

export const BOT_RUNTIME_REGISTRY_CAPACITY = 64;
/** A bot run holds its workload for at most the profile lifetime (900 s) plus margin. */
const DEFAULT_TTL_MS = 16 * 60_000;
const MAX_TTL_MS = 20 * 60_000;
const GenerationSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const ReferenceSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);

export interface BotRuntimeBinding {
  runtimeHandle: string;
  executionGeneration: string;
  ownerId: string;
  botId: string;
  chatId: string;
  taskId: string;
  runId: string;
  /** sha256 of the mounted workspace; the broker revalidates it before artifact effects. */
  rootFingerprint: string;
  route: BotModelRoute;
  accessSourceId: BotCredentialAccessSourceId;
  subscription?: import("./chatgpt-plan.js").ChatGptPlanBinding;
  capabilities: readonly BotToolCapability[];
  /** Funded priority for this run: a person waiting in chat, or a routine. */
  requestClass: "interactive" | "background";
}

export interface ManagedPiRuntimeBinding extends Omit<BotRuntimeBinding, "botId" | "taskId"> {
  kind: "managed_chat";
  workspace: { kind: "chat_workspace" } | import("../chat/execution-root.js").ChatExecutionRootProvenance;
}
export type PiRuntimeBinding = BotRuntimeBinding | ManagedPiRuntimeBinding;
export function isManagedPiBinding(binding: PiRuntimeBinding): binding is ManagedPiRuntimeBinding {
  return "kind" in binding && binding.kind === "managed_chat";
}
export type PiInferenceIdentity = Pick<PiRuntimeBinding, "runtimeHandle" | "executionGeneration" | "runId" | "ownerId" | "chatId">;
type StoredBinding = PiRuntimeBinding & { expiresAt: number; inference: AbortController };

export class BotRuntimeRegistryError extends Error {
  constructor(readonly code: "capacity_exceeded" | "invalid_binding") {
    super(`Bot runtime registry refused the binding: ${code}`);
    this.name = "BotRuntimeRegistryError";
  }
}

const BindingSchema = z.object({
  runtimeHandle: RuntimeHandleSchema,
  executionGeneration: GenerationSchema,
  ownerId: ReferenceSchema,
  botId: ChatAgentIdSchema,
  chatId: ReferenceSchema,
  taskId: ReferenceSchema,
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/),
  rootFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  route: BotModelRouteSchema,
  accessSourceId: BotCredentialAccessSourceIdSchema,
  subscription: z.object({peerId: z.uuid(), accountId: ReferenceSchema, computerId: ReferenceSchema, grantRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)}).strict().optional(),
  capabilities: z.array(BotToolCapabilitySchema).max(16),
  requestClass: z.enum(["interactive", "background"]),
}).strict();

const ManagedBindingSchema = BindingSchema.omit({ botId: true, taskId: true }).extend({
  kind: z.literal("managed_chat"),
  workspace: z.union([
    z.object({ kind: z.literal("chat_workspace") }).strict(),
    z.object({ ref: z.union([
      z.object({ kind: z.literal("project"), projectId: ReferenceSchema }).strict(),
      z.object({ kind: z.literal("worktree"), projectId: ReferenceSchema, worktreeId: ReferenceSchema }).strict(),
    ]), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]),
}).strict();

/** The broker action each model API uses; a route never reaches another. */
const INFERENCE_ACTION: Readonly<Record<BotModelRoute["api"], string>> = {
  "anthropic-messages": "inference.messages",
  "openai-responses": "inference.responses",
  "openai-completions": "inference.chat_completions",
};

export class BotRuntimeRegistry {
  private readonly entries = new Map<string, StoredBinding>();
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly ttlMs: number;

  constructor(options: { now?: () => number; capacity?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.capacity = Math.max(1, Math.min(Math.trunc(options.capacity ?? BOT_RUNTIME_REGISTRY_CAPACITY), BOT_RUNTIME_REGISTRY_CAPACITY));
    this.ttlMs = Math.max(1, Math.min(Math.trunc(options.ttlMs ?? DEFAULT_TTL_MS), MAX_TTL_MS));
  }

  get size(): number {
    this.sweep();
    return this.entries.size;
  }

  /** Expired bindings are swept before the capacity check, so stale runs never block admission. */
  bind(input: PiRuntimeBinding): void {
    const parsed = (isManagedPiBinding(input) ? ManagedBindingSchema : BindingSchema).safeParse(input);
    if (!parsed.success || (parsed.data.accessSourceId === "matrix_chatgpt_plan") !== Boolean(parsed.data.subscription)
      || parsed.data.subscription && parsed.data.route.api !== "openai-responses") throw new BotRuntimeRegistryError("invalid_binding");
    this.sweep();
    if (!this.entries.has(parsed.data.runtimeHandle) && this.entries.size >= this.capacity) {
      throw new BotRuntimeRegistryError("capacity_exceeded");
    }
    this.entries.get(parsed.data.runtimeHandle)?.inference.abort();
    this.entries.set(parsed.data.runtimeHandle, { ...parsed.data, expiresAt: this.now() + this.ttlMs, inference: new AbortController() });
  }

  /** The binding for a frame's runtime and generation; a stale generation never matches. */
  lookup(input: { runtimeHandle: string; executionGeneration: string }): PiRuntimeBinding | null {
    const runtimeHandle = RuntimeHandleSchema.safeParse(input.runtimeHandle);
    const generation = GenerationSchema.safeParse(input.executionGeneration);
    if (!runtimeHandle.success || !generation.success) return null;
    this.sweep();
    const entry = this.entries.get(runtimeHandle.data);
    if (!entry || entry.executionGeneration !== generation.data) return null;
    const { expiresAt: _expiresAt, inference: _inference, ...binding } = entry;
    return binding;
  }

  /** Bot frames must also name the bound run. */
  lookupRun(input: { runtimeHandle: string; executionGeneration: string; runId: string }): PiRuntimeBinding | null {
    const binding = this.lookup(input);
    return binding && binding.runId === input.runId ? binding : null;
  }

  /** Private run lifetime; never exposed in serialized runtime bindings. */
  inferenceSignal(input: PiInferenceIdentity): AbortSignal | null {
    const binding = this.lookupRun(input);
    if (!binding || binding.ownerId !== input.ownerId || binding.chatId !== input.chatId) return null;
    return this.entries.get(binding.runtimeHandle)!.inference.signal;
  }

  /** Stop inference immediately, retaining terminal event/session authority until release. */
  cancelInference(input: PiInferenceIdentity): void {
    if (this.inferenceSignal(input)) this.entries.get(input.runtimeHandle)!.inference.abort();
  }

  /** Inference only on the route's own action and model; bot runtimes never use egress. */
  authorize(input: {
    runtimeHandle: string;
    executionGeneration: string;
    action: ScopeRuntimeBrokerRequest["action"] | "inference.chat_completions";
    modelId?: string;
  }): BotInferenceAuthorization {
    const entry = this.lookup(input);
    if (!entry || input.action !== INFERENCE_ACTION[entry.route.api]
      || (input.modelId !== undefined && input.modelId !== entry.route.modelId)) {
      return { allowed: false };
    }
    return {
      allowed: true,
      accessSourceId: entry.accessSourceId,
      allowedModelIds: [entry.route.modelId],
      allowedEgressOrigins: [],
    };
  }

  release(runtimeHandleInput: string): void {
    const runtimeHandle = RuntimeHandleSchema.safeParse(runtimeHandleInput);
    if (runtimeHandle.success) {
      this.entries.get(runtimeHandle.data)?.inference.abort();
      this.entries.delete(runtimeHandle.data);
    }
  }

  shutdown(): void {
    for (const entry of this.entries.values()) entry.inference.abort();
    this.entries.clear();
  }

  private sweep(): void {
    const now = this.now();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        entry.inference.abort();
        this.entries.delete(handle);
      }
    }
  }
}
