import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { CanonicalProviderCatalogSchema, type CanonicalProviderCatalog, type CanonicalChatModelSelection } from "@matrix-os/contracts";
import { validateChatProviderSelection, ProviderCatalogUnavailableError, type ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { SafeVoiceErrorCode, VoiceCapability, VoiceRecoveryAction } from "@matrix-os/contracts/voice-session";
import {
  AoedeBootstrapRequestSchema, AoedeBootstrapResponseSchema, AoedeScopeSchema,
  type AoedeBootstrapRequest, type AoedeBootstrapResponse, type AoedeScope,
} from "@matrix-os/contracts";
import type { RequestPrincipal } from "../request-principal.js";
import type { ChatRecord } from "../chat/records.js";
import { canonicalJsonStringify } from "../chat/argument-digest.js";
import { AoedeBindingRepository, type AoedeBindingKey } from "./binding-repository.js";

export class AoedeBootstrapError extends Error {
  constructor(readonly code: SafeVoiceErrorCode, readonly status: 400 | 401 | 404 | 409 | 413 | 500 | 503,
    readonly retryable = false, readonly recovery: VoiceRecoveryAction = "none") {
    super("Assistant request failed");
    this.name = "AoedeBootstrapError";
  }
}
export interface AoedeBootstrapServiceDeps {
  repository: AoedeBindingRepository;
  catalog: Pick<ChatProviderCatalogService, "getCatalog">;
  /** Trusted immutable server configuration, never Host/query/body/client identity. */
  runtimeIdentity: { machineId: string; runtimeSlot: string } | { serverId: string };
  /** Existing project repository authorizes the exact requested project; null means unavailable. */
  resolveProject(principal: RequestPrincipal, projectId: string): Promise<AoedeScope | null>;
  /** Independent speech probe, overlapped with catalog discovery when supplied. */
  resolveSpeechCapability?(input: { principal: RequestPrincipal; surface: AoedeBootstrapRequest["surface"] }): Promise<VoiceCapability>;
  /** Canonical catalog default runnable route + server action policy + managed speech readiness.
   * Receives the saved route, or its same-instance catalog default when the saved
   * model is gone; it never substitutes a different Provider instance.
   * No provider inference, speech dispatch or microphone work occurs here.
   */
  resolveReadiness(input: { principal: RequestPrincipal; scope: AoedeScope;
    surface: AoedeBootstrapRequest["surface"]; selection: CanonicalChatModelSelection;
    catalog: CanonicalProviderCatalog; speechCapability?: VoiceCapability;
  }): Promise<{ selection: CanonicalChatModelSelection; capability: VoiceCapability }>;
}
function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJsonStringify(value)).digest("hex");
}
function unavailable(): never {
  throw new AoedeBootstrapError("chat_unavailable", 404, false, "start_new_session");
}
function conflict(): never {
  throw new AoedeBootstrapError("session_conflict", 409, false, "none");
}

export class AoedeBootstrapService {
  private readonly runtimeScope: string;
  constructor(private readonly deps: AoedeBootstrapServiceDeps) {
    const identityPart = z.string().trim().min(1).max(256);
    const identity = z.union([
      z.object({ machineId: identityPart, runtimeSlot: identityPart }).strict(),
      z.object({ serverId: identityPart }).strict(),
    ]).safeParse(deps.runtimeIdentity);
    if (!identity.success) throw new AoedeBootstrapError("internal_failure", 503, false, "contact_support");
    this.runtimeScope = hash(identity.data);
  }

  async bootstrap(principal: RequestPrincipal, input: AoedeBootstrapRequest): Promise<AoedeBootstrapResponse> {
    const request = AoedeBootstrapRequestSchema.parse(input);
    const scope = request.projectId === undefined
      ? { kind: "workspace" as const, id: "workspace", label: "Workspace" }
      : await this.deps.resolveProject(principal, request.projectId);
    if (!scope) unavailable();
    const safeScope = AoedeScopeSchema.parse(scope);
    if (request.projectId !== undefined && (safeScope.kind !== "project" || safeScope.id !== request.projectId)) unavailable();
    const key: AoedeBindingKey = { owner: { type: "personal", ownerId: principal.userId },
      runtimeScope: this.runtimeScope, projectScope: request.projectId ?? "" };
    const semanticHash = hash({ intent: request.intent, projectId: request.projectId ?? null, surface: request.surface });
    const previous = await this.deps.repository.getRequest(key, request.clientRequestId);
    if (previous && previous.semantic_hash !== semanticHash) conflict();
    const binding = await this.deps.repository.getBinding(key);
    const existingId = previous?.created_chat_id ?? (request.intent === "continue" ? binding?.chat_id : undefined);
    if (request.intent === "continue" && !previous && binding && binding.chat_id === null) unavailable();
    const existing = existingId ? await this.deps.repository.chats.get(key.owner, existingId) : null;
    if (existingId && !existing) unavailable();
    if (existing && (existing.projectId ?? undefined) !== request.projectId) unavailable();
    const savedSelection = existing?.chat.currentSelection;
    // Everything potentially external resolves before the single locking transaction.
    // A catalog outage is a retryable provider failure, not a generic 500 —
    // the UI distinguishes "try again" from "something broke".
    const [rawCatalog, speechCapability] = await Promise.all([
      this.deps.catalog.getCatalog(principal).catch((error: unknown) => {
        if (error instanceof ProviderCatalogUnavailableError) {
          throw new AoedeBootstrapError("provider_unavailable", 503, error.retryable, "retry_connection");
        }
        throw error;
      }),
      this.deps.resolveSpeechCapability?.({ principal, surface: request.surface }),
    ]);
    const catalog = CanonicalProviderCatalogSchema.parse(rawCatalog);
    const defaultSelection = catalog.instances.flatMap((instance) => instance.defaultSelection
      && validateChatProviderSelection({ catalog, selection: instance.defaultSelection }).ok
      ? [instance.defaultSelection] : [])[0];
    // A saved model that left the catalog while its Provider instance is still
    // available (a renamed model, or a placeholder written by an older build) is
    // repaired to that instance's catalog default and persisted below. The
    // instance never changes here; a missing or unavailable instance still fails
    // closed so the owner sees a truthful readiness error instead of a substitute.
    const repairedSelection = savedSelection && !validateChatProviderSelection({ catalog, selection: savedSelection }).ok
      ? catalog.instances.flatMap((instance) => instance.id === savedSelection.instanceId
        && instance.defaultSelection?.instanceId === savedSelection.instanceId
        && validateChatProviderSelection({ catalog, selection: instance.defaultSelection }).ok
        ? [instance.defaultSelection] : [])[0]
      : undefined;
    const selected = repairedSelection ?? savedSelection ?? defaultSelection;
    if (!selected) throw new AoedeBootstrapError("provider_unavailable", 503, true, "retry_connection");
    const readiness = await this.deps.resolveReadiness({ principal, scope: safeScope, surface: request.surface,
      selection: selected, catalog, ...(speechCapability ? { speechCapability } : {}) });
    if (hash(selected) !== hash(readiness.selection)) {
      throw new AoedeBootstrapError("provider_unavailable", 503, true, "retry_connection");
    }
    const runnable = validateChatProviderSelection({ catalog, selection: selected }).ok;
    const capability = { ...readiness.capability, surface: request.surface, sessionOnly: "unsupported" as const,
      ...(!runnable ? { status: "unavailable" as const, transportModes: [], turnModes: [],
        actionMode: "conversation_only" as const, actionCancellation: "none" as const, reason: "provider_unavailable" as const } : {}),
    };
    const responseFor = (record: ChatRecord) => AoedeBootstrapResponseSchema.parse({
      chatId: record.chat.id, scope: safeScope, selection: record.chat.currentSelection ?? readiness.selection, capability,
    });
    // Validate all server projections before writes too.
    AoedeBootstrapResponseSchema.parse({ chatId: "chat_preflight", scope: safeScope, selection: readiness.selection, capability });
    return this.deps.repository.withTransaction(async (repository) => {
      const { binding: locked, firstBinding } = await repository.lockBinding(key);
      const retry = await repository.getRequest(key, request.clientRequestId);
      if (retry && retry.semantic_hash !== semanticHash) conflict();
      let record: ChatRecord | null = null;
      if (retry) {
        record = await repository.chats.get(key.owner, retry.created_chat_id);
        if (!record) unavailable();
      } else if (request.intent === "continue" && !firstBinding) {
        if (!locked.chat_id) unavailable();
        record = await repository.chats.get(key.owner, locked.chat_id);
        if (!record) unavailable();
      } else {
        const identity = hash({ owner: key.owner, runtime: this.runtimeScope, scope: key.projectScope, request: request.clientRequestId });
        record = await repository.chats.create(key.owner, {
          id: `chat_aoede_${identity}`, clientRequestId: `req_aoede_${identity}`, title: "Aoede",
          ...(request.projectId ? { projectId: request.projectId } : {}), currentSelection: readiness.selection,
        });
        await repository.bind(key, record.chat.id);
      }
      if ((record.projectId ?? undefined) !== request.projectId) unavailable();
      if (record.chat.currentSelection && hash(record.chat.currentSelection) !== hash(readiness.selection)) {
        // Only the exact saved route inspected above may be repaired, under the
        // binding lock and the Chat's own revision CAS. Any other divergence is a
        // concurrent New/model change: readiness for a different route is never published.
        if (!repairedSelection || !savedSelection || hash(record.chat.currentSelection) !== hash(savedSelection)) conflict();
        record = await repository.chats.update(key.owner, record.chat.id,
          { baseRevision: record.chat.revision, currentSelection: readiness.selection });
      }
      const elected = await repository.recordRequest(key, request.clientRequestId, semanticHash, record.chat.id);
      if (!elected || elected.semantic_hash !== semanticHash || elected.created_chat_id !== record.chat.id) conflict();
      return responseFor(record);
    });
  }
}
