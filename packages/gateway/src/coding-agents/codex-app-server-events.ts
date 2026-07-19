import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  AgentThreadEventSchema,
  SafeDisplayStringSchema,
  UserInputQuestionSchema,
  type AgentThreadEvent,
} from "@matrix-os/contracts";

const MAX_APP_SERVER_LINE_BYTES = 64 * 1024;
const NativeRequestIdSchema = z.union([
  z.string().min(1).max(128),
  z.number().int().safe(),
]);
const NativeReferenceSchema = z.string().min(1).max(512);
const ApprovalMethodSchema = z.enum([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
]);
const NativeApprovalDecisionSchema = z.union([
  z.enum(["accept", "acceptForSession", "decline", "cancel"]),
  z.object({
    acceptWithExecpolicyAmendment: z.object({
      execpolicy_amendment: z.array(z.string().max(4000)).max(128),
    }).strict(),
  }).strict(),
  z.object({
    applyNetworkPolicyAmendment: z.object({
      network_policy_amendment: z.object({
        action: z.enum(["allow", "deny"]),
        host: z.string().min(1).max(255),
      }).strict(),
    }).strict(),
  }).strict(),
]);
const ExternalDisplayTextSchema = z.string().refine(
  (value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value),
);
const BaseRequestParamsSchema = z.object({
  threadId: NativeReferenceSchema,
  turnId: NativeReferenceSchema,
  itemId: NativeReferenceSchema,
}).passthrough();
const ApprovalRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: ApprovalMethodSchema,
  params: BaseRequestParamsSchema.extend({
    availableDecisions: z.array(z.unknown()).max(16).nullable().optional(),
  }).passthrough(),
}).passthrough();
const InputOptionSchema = z.object({
  label: ExternalDisplayTextSchema.min(1).max(160),
  description: ExternalDisplayTextSchema.max(1200).optional().default(""),
}).passthrough();
const NativeQuestionSchema = z.object({
  id: z.string().min(1).max(128),
  header: ExternalDisplayTextSchema.min(1).max(160),
  question: ExternalDisplayTextSchema.min(1).max(2400),
  options: z.array(InputOptionSchema).min(1).max(10).nullable().optional(),
  isOther: z.boolean().default(false),
  isSecret: z.boolean().default(false),
}).passthrough();
const InputRequestSchema = z.object({
  id: NativeRequestIdSchema,
  method: z.literal("item/tool/requestUserInput"),
  params: BaseRequestParamsSchema.extend({
    autoResolutionMs: z.number().int().min(0).max(240_000).nullable().optional(),
    questions: z.array(NativeQuestionSchema).min(1).max(8),
  }).passthrough(),
}).passthrough();
const AppServerRequestSchema = z.discriminatedUnion("method", [ApprovalRequestSchema, InputRequestSchema]);

type ApprovalMethod = z.infer<typeof ApprovalMethodSchema>;
type NativeRequestId = z.infer<typeof NativeRequestIdSchema>;

export interface CodexAppServerPendingRequest {
  nativeRequestId: NativeRequestId;
  method: ApprovalMethod | "item/tool/requestUserInput";
  correlationId: string;
  approvalId?: string;
  requestId?: string;
  questionIds?: Array<{ questionId: string; nativeQuestionId: string }>;
  nativeDecisionByMatrixDecision?: Partial<Record<
    "approve" | "approve_for_session" | "decline" | "cancel",
    z.infer<typeof NativeApprovalDecisionSchema>
  >>;
}

export interface CodexAppServerRequestContext {
  threadId: string;
  now: () => Date;
  nextEventId: () => string;
}

export interface CodexAppServerRequestParseResult {
  events: AgentThreadEvent[];
  pending?: CodexAppServerPendingRequest;
}

function digest(parts: readonly unknown[], length = 32): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, length);
}

function requestIdentity(request: z.infer<typeof AppServerRequestSchema>) {
  const parts = [
    request.method,
    request.id,
    request.params.threadId,
    request.params.turnId,
    request.params.itemId,
  ];
  return {
    correlationId: `corr_codex_${digest(parts)}`,
    approvalId: `appr_codex_${digest([...parts, "approval"])}`,
    requestId: `req_codex_${digest([...parts, "input"])}`,
  };
}

function safeDisplay(value: string, fallback: string): string {
  const parsed = SafeDisplayStringSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}

function boundedExternalText(value: string, maxChars: number, maxBytes: number): string {
  let result = "";
  for (const character of value) {
    const candidate = `${result}${character}`;
    if (candidate.length > maxChars || Buffer.byteLength(candidate, "utf8") > maxBytes) break;
    result = candidate;
  }
  return result;
}

function optionDescription(value: string): string {
  const bounded = boundedExternalText(value, 300, 1200);
  return bounded.trim() ? bounded : "Choose this option.";
}

function allowedDecisions(request: z.infer<typeof ApprovalRequestSchema>) {
  const source = request.params.availableDecisions;
  const native = Array.isArray(source)
    ? source.flatMap((decision) => {
      const parsed = NativeApprovalDecisionSchema.safeParse(decision);
      return parsed.success ? [parsed.data] : [];
    })
    : ["accept", "acceptForSession", "decline", "cancel"] as const;
  const nativeDecisionByMatrixDecision: NonNullable<
    CodexAppServerPendingRequest["nativeDecisionByMatrixDecision"]
  > = {};
  const mapped = native.map((decision) => {
    const matrixDecision = decision === "accept"
      ? "approve" as const
      : decision === "acceptForSession" || typeof decision === "object"
        ? "approve_for_session" as const
        : decision;
    nativeDecisionByMatrixDecision[matrixDecision] ??= decision;
    return matrixDecision;
  });
  const unique = mapped.filter((decision, index) => mapped.indexOf(decision) === index);
  if (unique.length === 0) {
    return {
      allowedDecisions: ["decline" as const, "cancel" as const],
      nativeDecisionByMatrixDecision: { decline: "decline" as const, cancel: "cancel" as const },
    };
  }
  return { allowedDecisions: unique, nativeDecisionByMatrixDecision };
}

function approvalCopy(method: ApprovalMethod): {
  title: string;
  safeDescription: string;
  actionKind: "command" | "file_change" | "provider";
  risk: "medium" | "high";
} {
  if (method === "item/commandExecution/requestApproval") {
    return {
      title: "Run command",
      safeDescription: "The coding agent wants to run a command.",
      actionKind: "command",
      risk: "medium",
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      title: "Change files",
      safeDescription: "The coding agent wants to change project files.",
      actionKind: "file_change",
      risk: "medium",
    };
  }
  return {
    title: "Change permissions",
    safeDescription: "The coding agent wants additional permissions.",
    actionKind: "provider",
    risk: "high",
  };
}

function approvalResult(
  request: z.infer<typeof ApprovalRequestSchema>,
  context: CodexAppServerRequestContext,
): CodexAppServerRequestParseResult {
  const identity = requestIdentity(request);
  const copy = approvalCopy(request.method);
  const decisions = allowedDecisions(request);
  const event = AgentThreadEventSchema.parse({
    type: "approval.requested",
    eventId: context.nextEventId(),
    threadId: context.threadId,
    occurredAt: context.now().toISOString(),
    approval: {
      approvalId: identity.approvalId,
      threadId: context.threadId,
      ...copy,
      allowedDecisions: decisions.allowedDecisions,
      correlationId: identity.correlationId,
    },
  });
  return {
    events: [event],
    pending: {
      nativeRequestId: request.id,
      method: request.method,
      correlationId: identity.correlationId,
      approvalId: identity.approvalId,
      nativeDecisionByMatrixDecision: decisions.nativeDecisionByMatrixDecision,
    },
  };
}

function inputResult(
  request: z.infer<typeof InputRequestSchema>,
  context: CodexAppServerRequestContext,
): CodexAppServerRequestParseResult {
  const nativeIds = request.params.questions.map((question) => question.id);
  if (new Set(nativeIds).size !== nativeIds.length) return { events: [] };
  const identity = requestIdentity(request);
  const questionIds: CodexAppServerPendingRequest["questionIds"] = [];
  const questions: Array<z.infer<typeof UserInputQuestionSchema>> = [];
  for (const [index, question] of request.params.questions.entries()) {
    const questionId = `question_codex_${digest([identity.requestId, question.id, index], 24)}`;
    const candidate = {
      questionId,
      header: safeDisplay(question.header, "Question"),
      question: boundedExternalText(question.question, 600, 2400),
      ...(question.options
        ? {
            options: question.options.map((option) => ({
              label: safeDisplay(option.label, "Option"),
              description: optionDescription(option.description),
            })),
          }
        : {}),
      allowOther: question.isOther,
      secret: question.isSecret,
    };
    const parsed = UserInputQuestionSchema.safeParse(candidate);
    const safeQuestion = parsed.success
      ? parsed.data
      : UserInputQuestionSchema.parse({
          questionId,
          header: safeDisplay(question.header, "Question"),
          question: "The coding agent needs an answer.",
          ...(question.options
            ? {
                options: question.options.map((_option, optionIndex) => ({
                  label: `Option ${optionIndex + 1}`,
                  description: "Choose this option.",
                })),
              }
            : {}),
          allowOther: question.isOther,
          secret: question.isSecret,
        });
    questionIds.push({ questionId, nativeQuestionId: question.id });
    questions.push(safeQuestion);
  }
  const firstHeader = questions[0]?.header ?? "Question";
  const autoResolutionMs = request.params.autoResolutionMs;
  const event = AgentThreadEventSchema.parse({
    type: "user_input.requested",
    eventId: context.nextEventId(),
    threadId: context.threadId,
    occurredAt: context.now().toISOString(),
    request: {
      requestId: identity.requestId,
      threadId: context.threadId,
      title: firstHeader,
      safeDescription: "The coding agent needs more information.",
      required: true,
      questions,
      ...(typeof autoResolutionMs === "number" && autoResolutionMs >= 60_000
        ? { autoResolutionMs }
        : {}),
      correlationId: identity.correlationId,
    },
  });
  return {
    events: [event],
    pending: {
      nativeRequestId: request.id,
      method: request.method,
      correlationId: identity.correlationId,
      requestId: identity.requestId,
      questionIds,
    },
  };
}

export function parseCodexAppServerRequestLine(
  line: string,
  context: CodexAppServerRequestContext,
): CodexAppServerRequestParseResult {
  if (Buffer.byteLength(line, "utf-8") > MAX_APP_SERVER_LINE_BYTES) return { events: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) {
      console.warn("[coding-agents] Codex app-server request parsing failed");
    }
    return { events: [] };
  }
  const parsed = AppServerRequestSchema.safeParse(raw);
  if (!parsed.success) return { events: [] };
  if (parsed.data.method === "item/permissions/requestApproval") return { events: [] };
  return parsed.data.method === "item/tool/requestUserInput"
    ? inputResult(parsed.data, context)
    : approvalResult(parsed.data, context);
}
