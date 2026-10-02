import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { WhatsAppSenderSchema } from "./config.js";
import {
  CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatRecordSchema,
  CanonicalChatDetailResponseSchema, CanonicalChatTurnAdmissionResponseSchema,
  CanonicalCreateChatRequestSchema, CanonicalCreateChatTurnRequestSchema,
  CanonicalProviderCatalogSchema,
  type CanonicalChatDetailResponse, type CanonicalChatRecord,
  type CanonicalProviderCatalog, type CanonicalChatModelSelection,
} from "@matrix-os/contracts";

export interface WhatsAppAgentTarget { machineId: string; gatewayUrl: string; token: string }
export interface WhatsAppAgentCheckpoint { machineId: string; chatId: string; runId: string }
export interface WhatsAppAgentStartResult extends WhatsAppAgentCheckpoint { replacedChatId?: string }
export interface WhatsAppAgentStart {
  owner: string; sender: string; messageId: string; text: string;
  chatId?: string; machineId?: string;
  /** Only pass true after versioned owner consent is persisted by account linking. */
  allowFullAccess?: boolean;
}
export type WhatsAppAgentPoll = { state: "pending" | "attention" } | { state: "complete"; text: string };
export class WhatsAppAgentClientError extends Error {
  constructor(readonly code: "unavailable" | "runtime_changed" | "invalid_response" | "request_failed" | "chat_not_found", options?: ErrorOptions) {
    super("Matrix is temporarily unavailable.", options);
    this.name = "WhatsAppAgentClientError";
  }
}

const reference = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/);
const StartSchema = z.object({
  owner: reference, sender: WhatsAppSenderSchema,
  messageId: z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:+/=-]+$/),
  text: z.string().trim().min(1).max(4096), chatId: CanonicalChatIdSchema.optional(),
  machineId: reference.optional(), allowFullAccess: z.boolean().optional(),
}).strict().refine((value) => Boolean(value.chatId) === Boolean(value.machineId));
const CheckpointSchema = z.object({ machineId: reference, chatId: CanonicalChatIdSchema, runId: CanonicalChatRunIdSchema }).strict();
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DETAIL_PAGES = 3;

function parse<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new WhatsAppAgentClientError("invalid_response");
  return result.data as T;
}
function requestId(...parts: string[]): string {
  return `req_${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}
function assertOwner(record: CanonicalChatRecord, owner: string, chatId?: string): void {
  const chat = record.chat;
  if (chat.ownerScope.type !== "personal" || chat.ownerScope.ownerId !== owner
    || (chatId !== undefined && chat.id !== chatId) || chat.lifecycle !== "active"
    || chat.collaboration?.mode === "shared" || record.projectId !== undefined) {
    throw new WhatsAppAgentClientError("invalid_response");
  }
}

function selectRoute(catalog: CanonicalProviderCatalog, record: CanonicalChatRecord, allowFullAccess: boolean): {
  selection: CanonicalChatModelSelection; permissionMode: string; interactionMode: string;
} {
  const binding = record.providerBinding?.instanceId ?? record.chat.currentSelection?.instanceId;
  const candidates = catalog.instances.filter((instance) => (
    catalog.drivers.some((driver) => driver.kind === instance.driverKind && driver.capabilityClass === "system_agent")
    && instance.availability === "available" && instance.connectionState !== "unavailable"
    && instance.connectionState !== "credit_required" && instance.supports.rootChat
    && instance.workspaceRequirement !== "project_required" && instance.supports.worktrees !== "required"
    && (binding === undefined || binding === instance.id)
  ));
  for (const instance of candidates) {
    const permissionMode = ["supervised", "read_only", "default", ...(allowFullAccess ? ["full_access"] : [])]
      .find((mode) => instance.supports.permissionModes.includes(mode));
    const interactionMode = ["default", "chat"].find((mode) => instance.supports.interactionModes.includes(mode));
    const saved = record.chat.currentSelection;
    const selection = saved?.instanceId === instance.id ? saved : instance.defaultSelection;
    if (!permissionMode || !interactionMode || !selection
      || !instance.models.some((model) => model.id === selection.model && model.availability === "available")) continue;
    return { selection, permissionMode, interactionMode };
  }
  throw new WhatsAppAgentClientError("unavailable");
}

async function boundedJson(response: Response, allowMissingChat = false): Promise<unknown> {
  if (!response.body) throw new WhatsAppAgentClientError("invalid_response");
  const reader = response.body.getReader();
  try {
    if (!response.ok && !(allowMissingChat && response.status === 404)) throw new WhatsAppAgentClientError("request_failed");
    const advertisedLength = response.headers.get("content-length");
    if (advertisedLength && Number(advertisedLength) > MAX_RESPONSE_BYTES) {
      throw new WhatsAppAgentClientError("invalid_response");
    }
    // A fixed buffer also bounds bookkeeping if a peer streams very small chunks.
    const buffer = Buffer.allocUnsafe(MAX_RESPONSE_BYTES);
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > MAX_RESPONSE_BYTES) throw new WhatsAppAgentClientError("invalid_response");
      buffer.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    try { return JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch (error) {
      if (error instanceof SyntaxError) throw new WhatsAppAgentClientError("invalid_response", { cause: error });
      throw error;
    }
  } finally {
    try { await reader.cancel(); }
    catch (error) { console.warn("[whatsapp/agent] Response cleanup failed", error instanceof Error ? error.name : "UnknownError"); }
    reader.releaseLock();
  }
}

export function createWhatsAppAgentClient(
  resolveTarget: (owner: string) => Promise<WhatsAppAgentTarget | null | undefined>,
  fetchImpl: typeof fetch = fetch,
) {
  async function targetFor(owner: string, machineId?: string): Promise<WhatsAppAgentTarget> {
    let target: WhatsAppAgentTarget | null | undefined;
    try { target = await resolveTarget(owner); }
    catch (error) { throw new WhatsAppAgentClientError("unavailable", { cause: error }); }
    if (!target || !reference.safeParse(target.machineId).success || !target.token
      || target.token.length > 8192 || /[\r\n]/.test(target.token)) throw new WhatsAppAgentClientError("unavailable");
    let url: URL;
    try { url = new URL(target.gatewayUrl); }
    catch (error) {
      if (error instanceof TypeError) throw new WhatsAppAgentClientError("unavailable", { cause: error });
      throw error;
    }
    // The injected resolver must construct this origin from authoritative machine data.
    // It must never accept a client-provided URL. HTTP supports the private VPS gateway hop.
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") throw new WhatsAppAgentClientError("unavailable");
    if (machineId !== undefined && target.machineId !== machineId) throw new WhatsAppAgentClientError("runtime_changed");
    return { ...target, gatewayUrl: url.origin };
  }
  async function request<T>(target: WhatsAppAgentTarget, path: string,
    schema: Parameters<typeof parse<T>>[0], body?: unknown, allowMissingChat = false): Promise<T> {
    try {
      const response = await fetchImpl(`${target.gatewayUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${target.token}`, accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      const value = await boundedJson(response, allowMissingChat);
      if (!response.ok) {
        const missing = z.object({ error: z.object({ code: z.literal("chat_not_found"),
          safeMessage: z.literal("Chat not found."), retryable: z.literal(false) }).strict() }).strict();
        throw new WhatsAppAgentClientError(missing.safeParse(value).success ? "chat_not_found" : "request_failed");
      }
      return parse(schema, value);
    } catch (error) {
      if (error instanceof WhatsAppAgentClientError) throw error;
      throw new WhatsAppAgentClientError("request_failed", { cause: error });
    }
  }
  async function detail(target: WhatsAppAgentTarget, owner: string, chatId: string, cursor?: string) {
    const query = new URLSearchParams({ limit: "200", messageVersion: "2", inputVersion: "1" });
    if (cursor) query.set("cursor", cursor);
    const result = await request(target, `/api/chats/${chatId}?${query}`, CanonicalChatDetailResponseSchema, undefined, true);
    assertOwner(result.record, owner, chatId);
    return result;
  }
  return {
    async start(inputValue: WhatsAppAgentStart, authorizeAdmission?: () => Promise<boolean>): Promise<WhatsAppAgentStartResult> {
      const input = parse(StartSchema, inputValue);
      const target = await targetFor(input.owner, input.machineId);
      let chatId = input.chatId;
      let replacedChatId: string | undefined;
      let current: CanonicalChatDetailResponse | undefined;
      if (chatId) {
        try { current = await detail(target, input.owner, chatId); }
        catch (error) {
          if (!(error instanceof WhatsAppAgentClientError) || error.code !== "chat_not_found") throw error;
          // Only the authenticated owner's canonical missing-Chat response permits
          // replacement. Auth, proxy, transient and malformed errors fail closed.
          replacedChatId = chatId;
          chatId = undefined;
        }
      }
      if (!chatId) {
        if (authorizeAdmission && !await authorizeAdmission()) throw new WhatsAppAgentClientError("unavailable");
        // Each deleted generation gets a different stable idempotency key.
        const create = CanonicalCreateChatRequestSchema.parse({
          clientRequestId: requestId("whatsapp-chat", input.owner, target.machineId, ...(replacedChatId ? [replacedChatId] : [])),
          title: "Matrix · WhatsApp",
        });
        const record = await request(target, "/api/chats", CanonicalChatRecordSchema, create);
        assertOwner(record, input.owner);
        if (record.chat.id === replacedChatId) throw new WhatsAppAgentClientError("invalid_response");
        chatId = record.chat.id;
      }
      current ??= await detail(target, input.owner, chatId);
      const replacement = replacedChatId ? { replacedChatId } : {};
      const clientRequestId = requestId("whatsapp-turn", input.owner, target.machineId, input.sender, input.messageId);
      // A crash after admission must recover the existing run before reselecting model/modes.
      const previous = current.turns.find((turn) => turn.clientRequestId === clientRequestId);
      if (previous) {
        const original = current.runs.find((run) => run.turnId === previous.id && run.attempt === 1);
        if (!original) throw new WhatsAppAgentClientError("invalid_response");
        return { machineId: target.machineId, chatId, runId: original.id, ...replacement };
      }
      const catalog = await request(target, "/api/chat-providers?includeConnectionState=true", CanonicalProviderCatalogSchema);
      const route = selectRoute(catalog, current.record, input.allowFullAccess === true);
      const payload = CanonicalCreateChatTurnRequestSchema.parse({
        clientRequestId, baseRevision: current.record.chat.revision,
        parts: [{ type: "text", text: input.text }], ...route,
      });
      // Catalog and Chat reads can take time. Recheck the durable consent/fence
      // immediately before submission; revocation during preparation must stop admission.
      if (authorizeAdmission && !await authorizeAdmission()) throw new WhatsAppAgentClientError("unavailable");
      const admitted = await request(target, `/api/chats/${chatId}/turns`, CanonicalChatTurnAdmissionResponseSchema, payload);
      assertOwner(admitted.record, input.owner, chatId);
      if (admitted.turn.clientRequestId !== clientRequestId) throw new WhatsAppAgentClientError("invalid_response");
      return { machineId: target.machineId, chatId, runId: admitted.run.id, ...replacement };
    },
    async poll(owner: string, checkpointValue: WhatsAppAgentCheckpoint): Promise<WhatsAppAgentPoll> {
      parse(reference, owner);
      const checkpoint = parse(CheckpointSchema, checkpointValue);
      const target = await targetFor(owner, checkpoint.machineId);
      let cursor: string | undefined;
      let foundRun: CanonicalChatDetailResponse["runs"][number] | undefined;
      const messages: CanonicalChatDetailResponse["messages"] = [];
      for (let page = 0; page < MAX_DETAIL_PAGES; page++) {
        const response = await detail(target, owner, checkpoint.chatId, cursor);
        foundRun ??= response.runs.find((run) => run.id === checkpoint.runId);
        messages.push(...response.messages.filter((message) => message.runId === checkpoint.runId
          && message.role === "assistant" && message.state === "committed"));
        if (foundRun && ["accepted", "running"].includes(foundRun.status)) return { state: "pending" };
        if (foundRun && foundRun.status !== "completed") return { state: "attention" };
        const oldest = response.messages[0]?.seq;
        if (!response.nextCursor || (foundRun && oldest !== undefined && oldest <= foundRun.historyBoundarySeq + 1)) {
          if (!foundRun) return { state: "attention" };
          const text = messages.sort((a, b) => a.seq - b.seq)
            .flatMap((message) => message.parts.flatMap((part) => part.type === "text" ? [part.text] : []))
            .join("\n\n").trim();
          if (!text) return { state: "attention" };
          const suffix = "\n\nOpen Matrix for the full reply.";
          const shortened = text.slice(0, 4000 - suffix.length).replace(/[\uD800-\uDBFF]$/, "");
          return { state: "complete", text: text.length <= 4000 ? text : shortened + suffix };
        }
        if (response.nextCursor === cursor) return { state: "attention" };
        cursor = response.nextCursor;
      }
      return { state: "attention" };
    },
  };
}
export type WhatsAppAgentClient = ReturnType<typeof createWhatsAppAgentClient>;
