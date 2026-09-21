import { RuntimeHandleSchema } from "@matrix-os/scope-runtime";
import type { ScopeRuntimeBrokerRequest } from "@matrix-os/scope-runtime/broker-protocol";
import { z } from "zod/v4";
import {
  KernelCredentialAccessSourceIdSchema,
  type KernelCredentialAccessSourceId,
} from "../domains/integrations/kernel-credentials.js";
import type { ScopeRuntimeBrokerAuthorization } from "./scope-runtime-broker.js";
const MAX_CAPACITY = 64;
const MAX_TTL_MS = 5 * 60_000;
const GenerationSchema = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const ReferenceSchema = z.string().min(1).max(256);
const ModelSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+$/);
export interface SharedAiRuntimeBinding {
  runtimeHandle: string;
  scopeId: string;
  chatId: string;
  ownerId: string;
  actorId: string;
  executionGeneration: string;
  providerIdentity:
    | { driverKind: "claude_code"; instanceId: "claude_shared"; accessSourceId: KernelCredentialAccessSourceId }
    | { driverKind: "codex"; instanceId: "codex_default" };
  modelId?: string;
}
interface StoredBinding extends SharedAiRuntimeBinding {
  expiresAt: number;
}
export class SharedAiRuntimeRegistry {
  private readonly entries = new Map<string, StoredBinding>();
  private readonly now: () => Date;
  private readonly capacity: number;
  private readonly ttlMs: number;
  constructor(options: { now?: () => Date; capacity?: number; ttlMs?: number } = {}) {
    this.now = options.now ?? (() => new Date());
    this.capacity = Math.max(1, Math.min(Math.trunc(options.capacity ?? MAX_CAPACITY), MAX_CAPACITY));
    this.ttlMs = Math.max(1, Math.min(Math.trunc(options.ttlMs ?? 2 * 60_000), MAX_TTL_MS));
  }
  get size(): number {
    this.sweep();
    return this.entries.size;
  }
  bind(input: SharedAiRuntimeBinding): void {
    const binding = parseBinding(input);
    this.sweep();
    if (!this.entries.has(binding.runtimeHandle) && this.entries.size >= this.capacity) {
      throw new Error("Shared AI runtime registry is at capacity");
    }
    this.entries.set(binding.runtimeHandle, {
      ...binding,
      expiresAt: this.now().getTime() + this.ttlMs,
    });
  }
  selectModel(runtimeHandleInput: string, modelIdInput: string): void {
    const runtimeHandle = RuntimeHandleSchema.parse(runtimeHandleInput);
    const modelId = ModelSchema.parse(modelIdInput);
    this.sweep();
    const current = this.entries.get(runtimeHandle);
    if (!current) throw new Error("Shared AI runtime is unavailable");
    this.entries.set(runtimeHandle, {
      ...current,
      modelId,
      expiresAt: this.now().getTime() + this.ttlMs,
    });
  }
  lookup(input: { runtimeHandle: string; executionGeneration: string }): SharedAiRuntimeBinding | null {
    const runtimeHandle = RuntimeHandleSchema.safeParse(input.runtimeHandle);
    const generation = GenerationSchema.safeParse(input.executionGeneration);
    if (!runtimeHandle.success || !generation.success) return null;
    this.sweep();
    const entry = this.entries.get(runtimeHandle.data);
    if (!entry || entry.executionGeneration !== generation.data) return null;
    const { expiresAt: _expiresAt, ...binding } = entry;
    return binding;
  }
  authorize(input: {
    runtimeHandle: string;
    executionGeneration: string;
    action: ScopeRuntimeBrokerRequest["action"];
    modelId?: string;
    url?: string;
  }): ScopeRuntimeBrokerAuthorization {
    const entry = this.lookup(input);
    const expectedAction = entry?.providerIdentity.driverKind === "codex"
      ? "inference.responses"
      : "inference.messages";
    if (!entry || input.action !== expectedAction || !entry.modelId
      || (input.modelId !== undefined && input.modelId !== entry.modelId)) {
      return { allowed: false };
    }
    return {
      allowed: true,
      ...(entry.providerIdentity.driverKind === "claude_code"
        ? { accessSourceId: entry.providerIdentity.accessSourceId }
        : {}),
      providerIdentity: entry.providerIdentity.driverKind === "codex"
        ? { driverKind: "codex", instanceId: "codex_default" }
        : { driverKind: "claude_code", instanceId: "claude_shared" },
      allowedModelIds: [entry.modelId],
      allowedEgressOrigins: [],
    };
  }
  release(runtimeHandleInput: string): void {
    const runtimeHandle = RuntimeHandleSchema.safeParse(runtimeHandleInput);
    if (runtimeHandle.success) this.entries.delete(runtimeHandle.data);
  }
  shutdown(): void {
    this.entries.clear();
  }
  private sweep(): void {
    const now = this.now().getTime();
    for (const [handle, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(handle);
    }
  }
}
function parseBinding(input: SharedAiRuntimeBinding): SharedAiRuntimeBinding {
  return {
    runtimeHandle: RuntimeHandleSchema.parse(input.runtimeHandle),
    scopeId: z.uuid().parse(input.scopeId),
    chatId: ReferenceSchema.parse(input.chatId),
    ownerId: ReferenceSchema.parse(input.ownerId),
    actorId: ReferenceSchema.parse(input.actorId),
    executionGeneration: GenerationSchema.parse(input.executionGeneration),
    providerIdentity: input.providerIdentity.driverKind === "codex"
      ? z.object({ driverKind: z.literal("codex"), instanceId: z.literal("codex_default") })
        .strict().parse(input.providerIdentity)
      : z.object({
          driverKind: z.literal("claude_code"),
          instanceId: z.literal("claude_shared"),
          accessSourceId: KernelCredentialAccessSourceIdSchema,
        }).strict().parse(input.providerIdentity),
    ...(input.modelId === undefined ? {} : { modelId: ModelSchema.parse(input.modelId) }),
  };
}
