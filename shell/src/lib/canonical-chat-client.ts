import {
  CanonicalChatDetailResponseSchema,
  CanonicalChatApprovalDecisionSchema,
  CanonicalChatApprovalSubmissionResponseSchema,
  CanonicalChatIdSchema,
  CanonicalChatListResponseSchema,
  CanonicalChatRecordSchema,
  CanonicalChatRequestIdSchema,
  CanonicalChatRunIdSchema,
  CanonicalChatRunCancellationResponseSchema,
  CanonicalChatTurnAdmissionResponseSchema,
  CanonicalSubmitChatApprovalRequestSchema,
  CanonicalCreateChatRequestSchema,
  CanonicalCreateChatTurnRequestSchema,
  type CanonicalChatDetailResponse,
  type CanonicalChatApprovalDecision,
  type CanonicalChatApprovalSubmissionResponse,
  type CanonicalChatListResponse,
  type CanonicalChatMessage,
  type CanonicalChatMessagePart,
  type CanonicalChatRecord,
  type CanonicalChatRunCancellationResponse,
  type CanonicalChatTurnAdmissionResponse,
  type CanonicalCreateChatRequest,
  type CanonicalCreateChatTurnRequest,
} from "@matrix-os/contracts";
import type { ChatMessage } from "@/lib/chat";

const REQUEST_TIMEOUT_MS = 10_000;

export interface CanonicalShellChatClient {
  list(): Promise<CanonicalChatListResponse>;
  create(input: CanonicalCreateChatRequest): Promise<CanonicalChatRecord>;
  detail(chatId: string): Promise<CanonicalChatDetailResponse>;
  admitTurn(chatId: string, input: CanonicalCreateChatTurnRequest): Promise<CanonicalChatTurnAdmissionResponse>;
  cancelRun(chatId: string, runId: string, clientRequestId: string): Promise<CanonicalChatRunCancellationResponse>;
  uploadAttachment(file: ShellAttachmentInput): Promise<CanonicalAttachmentReference>;
  deleteAttachment(ownerReference: string): Promise<void>;
  submitApproval(
    chatId: string,
    runId: string,
    approvalId: string,
    decision: CanonicalChatApprovalDecision,
    clientRequestId: string,
  ): Promise<CanonicalChatApprovalSubmissionResponse>;
}

export interface ShellAttachmentInput {
  name: string;
  type: string;
  data: string;
}

type CanonicalAttachmentReference = Extract<CanonicalChatMessagePart, { type: "attachment_reference" }>;

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 7 * 1024 * 1024;
const DATA_URL = /^data:([^;,]{1,120});base64,([A-Za-z0-9+/]*={0,2})$/;
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+/-]+$/;
const SAFE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DIRECT_CHAT_ATTACHMENT_REFERENCE = /^temporary\/desktop-chat\/([^/\\\u0000-\u001f\u007f]{1,255})$/;

function safeReference(value: string): string {
  if (!SAFE_REFERENCE.test(value)) throw new Error("InvalidCanonicalReference");
  return value;
}

function isDirectChatAttachmentReference(value: string): boolean {
  const match = DIRECT_CHAT_ATTACHMENT_REFERENCE.exec(value);
  return match !== null && match[1] !== "." && match[1] !== "..";
}

function attachmentBytes(file: ShellAttachmentInput): { bytes: Uint8Array<ArrayBuffer>; mimeType: string } {
  if (file.data.length > MAX_DATA_URL_LENGTH) throw new Error("AttachmentTooLarge");
  const match = DATA_URL.exec(file.data);
  if (!match) throw new Error("InvalidAttachmentData");
  const mimeType = file.type && SAFE_MIME_TYPE.test(file.type) ? file.type : match[1]!;
  if (!SAFE_MIME_TYPE.test(mimeType)) throw new Error("InvalidAttachmentType");
  const decoded = atob(match[2]!);
  if (decoded.length > MAX_ATTACHMENT_BYTES) throw new Error("AttachmentTooLarge");
  const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return { bytes, mimeType };
}

function safeAttachmentName(name: string): { label: string; pathName: string } {
  const label = name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) || "Attachment";
  const pathName = label.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+$/, "Attachment").slice(0, 120);
  return { label, pathName: pathName || "Attachment" };
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) throw new CanonicalShellChatRequestError(response.status);
  return response.json();
}

export class CanonicalShellChatRequestError extends Error {
  constructor(readonly status: number) {
    super("Canonical Chat request failed");
    this.name = "CanonicalShellChatRequestError";
  }
}

export function isDefinitiveCanonicalChatRejection(error: unknown): boolean {
  return error instanceof CanonicalShellChatRequestError
    && error.status >= 400
    && error.status < 500;
}

export function createCanonicalShellChatClient(options: {
  gatewayUrl: string;
  fetchFn?: typeof fetch;
  createId?: () => string;
}): CanonicalShellChatClient {
  const fetchFn = options.fetchFn ?? fetch;
  const request = (path: string, init: RequestInit = {}) => fetchFn(`${options.gatewayUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).then(jsonResponse);
  const createId = options.createId ?? (() => globalThis.crypto.randomUUID().replaceAll("-", ""));
  return {
    async list() {
      return CanonicalChatListResponseSchema.parse(await request("/api/chats?limit=100&scope=global"));
    },
    async create(input) {
      const body = CanonicalCreateChatRequestSchema.parse(input);
      return CanonicalChatRecordSchema.parse(await request("/api/chats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    },
    async detail(chatId) {
      const id = CanonicalChatIdSchema.parse(chatId);
      return CanonicalChatDetailResponseSchema.parse(await request(`/api/chats/${encodeURIComponent(id)}?limit=200`));
    },
    async admitTurn(chatId, input) {
      const id = CanonicalChatIdSchema.parse(chatId);
      const body = CanonicalCreateChatTurnRequestSchema.parse(input);
      return CanonicalChatTurnAdmissionResponseSchema.parse(await request(`/api/chats/${encodeURIComponent(id)}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
    },
    async cancelRun(chatId, runId, clientRequestId) {
      const id = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const parsedRequestId = CanonicalChatRequestIdSchema.parse(clientRequestId);
      return CanonicalChatRunCancellationResponseSchema.parse(await request(
        `/api/chats/${encodeURIComponent(id)}/runs/${encodeURIComponent(parsedRunId)}/cancel`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientRequestId: parsedRequestId }),
        },
      ));
    },
    async uploadAttachment(file) {
      const { bytes, mimeType } = attachmentBytes(file);
      const id = createId().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80);
      if (!id) throw new Error("InvalidAttachmentId");
      const { label, pathName } = safeAttachmentName(file.name);
      const path = `temporary/desktop-chat/${id}-${pathName}`;
      const response = await request(`/api/files/blob?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "Content-Type": mimeType },
        body: new Blob([bytes], { type: mimeType }),
      });
      if (typeof response !== "object" || response === null
        || !("ok" in response) || response.ok !== true
        || !("path" in response) || response.path !== path
        || !("size" in response) || response.size !== bytes.byteLength) {
        throw new Error("InvalidAttachmentUploadResponse");
      }
      return {
        type: "attachment_reference",
        attachmentId: `shell_upload_${id}`,
        kind: mimeType.startsWith("image/") ? "image" : "file",
        label,
        mimeType,
        sizeBytes: bytes.byteLength,
        ownerReference: path,
      };
    },
    async deleteAttachment(ownerReference) {
      if (!isDirectChatAttachmentReference(ownerReference)) {
        throw new Error("InvalidAttachmentReference");
      }
      const response = await request(`/api/files/blob?path=${encodeURIComponent(ownerReference)}`, {
        method: "DELETE",
      });
      if (typeof response !== "object" || response === null
        || !("ok" in response) || response.ok !== true
        || !("path" in response) || response.path !== ownerReference
        || !("deleted" in response) || typeof response.deleted !== "boolean") {
        throw new Error("InvalidAttachmentDeleteResponse");
      }
    },
    async submitApproval(chatId, runId, approvalId, decision, clientRequestId) {
      const id = CanonicalChatIdSchema.parse(chatId);
      const parsedRunId = CanonicalChatRunIdSchema.parse(runId);
      const parsedApprovalId = safeReference(approvalId);
      const body = CanonicalSubmitChatApprovalRequestSchema.parse({
        clientRequestId: CanonicalChatRequestIdSchema.parse(clientRequestId),
        decision: CanonicalChatApprovalDecisionSchema.parse(decision),
      });
      return CanonicalChatApprovalSubmissionResponseSchema.parse(await request(
        `/api/chats/${encodeURIComponent(id)}/runs/${encodeURIComponent(parsedRunId)}/approvals/${encodeURIComponent(parsedApprovalId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      ));
    },
  };
}

function partText(part: CanonicalChatMessage["parts"][number]): string | null {
  if (part.type === "text" || part.type === "summary") return part.text;
  if (part.type === "status") return part.detail ? `${part.label}: ${part.detail}` : part.label;
  if (part.type === "tool_request") return `Using ${part.label}...`;
  if (part.type === "tool_result") return part.text ?? `Tool ${part.outcome}`;
  if (part.type === "approval_request") return `${part.title}: ${part.description}`;
  if (part.type === "approval_result") return `Approval ${part.decision.replaceAll("_", " ")}`;
  if (part.type === "attachment_reference") return `Attached ${part.label}`;
  if (part.type === "resource_reference") return `Referenced ${part.resource.label}`;
  if (part.type === "invocation_reference") return part.invocation.invocation;
  return null;
}

export function projectCanonicalMessages(messages: CanonicalChatMessage[]): ChatMessage[] {
  const resolvedApprovals = new Set(messages.flatMap((message) => message.parts.flatMap((part) =>
    part.type === "approval_result" && message.runId
      ? [`${message.runId}\0${part.approvalId}`]
      : [])));
  return messages.flatMap((message) => {
    const content = message.parts.map(partText).filter((part): part is string => part !== null).join("\n");
    if (!content) return [];
    const toolRequest = message.parts.find((part) => part.type === "tool_request");
    const approvalRequest = message.parts.find((part) => part.type === "approval_request");
    return [{
      id: message.id,
      role: message.role === "user" || message.role === "assistant" ? message.role : "system",
      content,
      timestamp: Date.parse(message.createdAt),
      ...(toolRequest?.type === "tool_request" ? { tool: toolRequest.name } : {}),
      ...(message.runId ? { requestId: message.runId } : {}),
      ...(approvalRequest?.type === "approval_request" ? { metadata: { canonicalApproval: {
        ...(message.runId ? { runId: message.runId } : {}),
        approvalId: approvalRequest.approvalId,
        title: approvalRequest.title,
        description: approvalRequest.description,
        risk: approvalRequest.risk,
        allowedDecisions: approvalRequest.allowedDecisions,
        pending: !message.runId
          || !resolvedApprovals.has(`${message.runId}\0${approvalRequest.approvalId}`),
      } } } : {}),
    }];
  });
}
