import { createHash } from "node:crypto";
import { MATRIX_OPENAI_API_INSTANCE_ID, MATRIX_PI_OPENAI_API_INSTANCE_ID, type MatrixOpenAiConnection, type CanonicalProviderCatalog, type CanonicalProviderInstanceDescriptor } from "@matrix-os/contracts";
import { MANAGED_PI_CHAT_SUPPORTS } from "../chat/managed-chat-catalog.js";
import type { ChatProviderCatalogService } from "../chat/provider-catalog.js";
import type { AiProviderSnapshotReader } from "../ai-providers/service.js";
import { MATRIX_BOT_DRIVER } from "./provider-instance.js";
/** Display projection retains source identity; owner qualification and inference are separate. */
export function withMatrixOpenAiProviderInstances(base: Pick<ChatProviderCatalogService, "getCatalog">,
  providers: AiProviderSnapshotReader, runtimeAvailable: () => boolean, ownerId: string | null): Pick<ChatProviderCatalogService, "getCatalog"> {
  return { async getCatalog(principal, selection): Promise<CanonicalProviderCatalog> {
    const catalog = await base.getCatalog(principal, selection?.instanceId === MATRIX_OPENAI_API_INSTANCE_ID ? undefined : selection);
    if (!ownerId || principal.userId !== ownerId) return catalog;
    const source = (await providers.getSnapshot({ admissionScope: "managed_matrix", suppressFundedProbes: true })).matrixOpenAiConnection;
    if (!source) return catalog;
    return projectMatrixOpenAiProviderInstances(catalog, source, runtimeAvailable());
  } };
}

/** Shared descriptor projection; absent source is unavailable only for this observation. */
export function projectMatrixOpenAiProviderInstances(catalog: CanonicalProviderCatalog, source: MatrixOpenAiConnection | undefined, runnable: boolean): CanonicalProviderCatalog {
  const ready = source !== undefined && source.state === "ready" && source.enabled && source.credentialGeneration === source.sourceCredentialGeneration;
  const revision = `openai_${createHash("sha256").update(JSON.stringify({ base: catalog.revision, source, runnable })).digest("hex").slice(0, 32)}`;
  const selectionOptions = ready ? [{ id: "connectionRevision", value: String(source!.revision) }, { id: "credentialGeneration", value: source!.credentialGeneration! }, { id: "api", value: "openai-responses" }] : [];
  const instance: CanonicalProviderInstanceDescriptor = {
    id: MATRIX_OPENAI_API_INSTANCE_ID, driverKind: "matrix_bot", displayName: "OpenAI API", connectionLabel: "OpenAI API",
    availability: ready && runnable && source!.supports.recipeBots ? "available" : "unavailable", workspaceRequirement: "none", catalogRevision: revision,
    models: ready && runnable && source!.supports.recipeBots ? source!.models.slice(0, 64).map(model => ({ id: model.id, displayName: model.displayName, availability: "available", capabilities: model.input?.includes("image") ? ["tools", "vision"] : ["tools"], supportsToolUse: true, supportsVision: model.input?.includes("image") ?? false })) : [],
    options: selectionOptions.map(option => ({ id: option.id, label: option.id === "api" ? "API" : option.id === "connectionRevision" ? "Connection" : "Credential", kind: "enum", placement: "advanced",
      values: option.id === "api" ? [{ value: "openai-responses", label: "Responses" }, { value: "openai-completions", label: "Chat Completions" }] : [{ value: option.value, label: "Current connection" }], defaultValue: option.value })), skills: [], commands: [],
    setupActions: [{ id: "matrix_openai_settings", kind: "open_settings", label: "Agents & providers" }],
    supports: { rootChat: false, resume: false, cancellation: true, steering: "same_run", attachments: ["file", "image"], tools: [], approvals: false,
      userInput: false, worktrees: "none", resources: [], interactionModes: ["default"], permissionModes: ["default"] },
  };
  if (instance.availability === "available" && source!.models[0]) instance.defaultSelection = { instanceId: instance.id, model: source!.models[0].id, options: selectionOptions };
  const chat: CanonicalProviderInstanceDescriptor = { ...instance, id: MATRIX_PI_OPENAI_API_INSTANCE_ID, driverKind: "matrix_pi",
    displayName: "Matrix AI · OpenAI API", workspaceRequirement: "project_optional", supports: MANAGED_PI_CHAT_SUPPORTS,
    availability: ready && runnable && source!.supports.rootChat ? "available" : "unavailable",
    models: ready && runnable && source!.supports.rootChat ? source!.models.slice(0, 64).map(model => ({ id: model.id, displayName: model.displayName, availability: "available", capabilities: model.input?.includes("image") ? ["tools", "vision"] : ["tools"], supportsToolUse: true, supportsVision: model.input?.includes("image") ?? false })) : [],
    ...(!runnable ? { unavailabilityReason: "runtime_unavailable" } : {}),
  };
  delete chat.defaultSelection;
  if (chat.availability === "available" && source!.models[0]) chat.defaultSelection = { instanceId: chat.id, model: source!.models[0].id, options: selectionOptions };
  const drivers = [...catalog.drivers];
  if (!drivers.some(driver => driver.kind === "matrix_bot")) drivers.push(MATRIX_BOT_DRIVER);
  if (!drivers.some(driver => driver.kind === "matrix_pi")) drivers.push({ kind: "matrix_pi", displayName: "Pi", adapterVersion: "1.0.0", capabilityClass: "system_agent" });
  return { ...catalog, revision, drivers, instances: [...catalog.instances.filter(i => i.id !== chat.id && i.id !== instance.id).map(i => ({ ...i, catalogRevision: revision })), instance, chat] };
}
