import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { extname, resolve } from "node:path";
import { z } from "zod/v4";
import {
  ApprovalDecisionRequestSchema,
  ApprovalIdSchema,
  RequestIdSchema,
  UserInputAnswerRequestSchema,
} from "@matrix-os/contracts";
import { codexProviderEventPath } from "./codex-event-bridge.js";

const SessionIdSchema = z.string().regex(/^sess_[A-Za-z0-9_-]{1,128}$/);
const MatrixQuestionIdSchema = z.string().regex(/^question_codex_[a-f0-9]{24}$/);
const StructuredAnswersSchema = z.record(
  MatrixQuestionIdSchema,
  z.array(z.string().min(1).max(400).refine((value) => Buffer.byteLength(value, "utf8") <= 700))
    .min(1).max(4),
).superRefine((answers, context) => {
  const count = Object.keys(answers).length;
  if (count < 1 || count > 8) context.addIssue({ code: "custom", message: "Invalid answer count" });
});
const ApprovalFrameSchema = z.object({
  type: z.literal("approval"),
  approvalId: ApprovalIdSchema.refine((value) => /^appr_codex_[a-f0-9]{32}$/.test(value)),
  decision: ApprovalDecisionRequestSchema.shape.decision,
  clientRequestId: RequestIdSchema,
}).strict();
const InputFrameSchema = z.object({
  type: z.literal("input"),
  requestId: RequestIdSchema.refine((value) => /^req_codex_[a-f0-9]{32}$/.test(value)),
  structuredAnswers: StructuredAnswersSchema,
  clientRequestId: RequestIdSchema,
}).strict();
const ControlFrameSchema = z.discriminatedUnion("type", [ApprovalFrameSchema, InputFrameSchema]);
const ControlResponseSchema = z.union([
  z.object({ ok: z.literal(true), replayed: z.boolean().optional() }).strict(),
  z.object({ ok: z.literal(false) }).strict(),
]);

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024;

export interface CodexControlClient {
  submitApproval(input: {
    sessionId: string;
    approvalId: string;
    decision: "approve" | "approve_for_session" | "decline" | "cancel";
    clientRequestId: string;
  }): Promise<void>;
  submitInput(input: {
    sessionId: string;
    inputRequestId: string;
    structuredAnswers: NonNullable<z.infer<typeof UserInputAnswerRequestSchema>["structuredAnswers"]>;
    clientRequestId: string;
  }): Promise<void>;
}

export function codexProviderControlPath(homePath: string, sessionId: string): string {
  const eventPath = codexProviderEventPath(resolve(homePath), SessionIdSchema.parse(sessionId));
  return `${eventPath.slice(0, -extname(eventPath).length)}.sock`;
}

export function createCodexControlClient(options: {
  homePath: string;
  timeoutMs?: number;
}): CodexControlClient {
  const homePath = resolve(options.homePath);
  const requestedTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(1, Math.min(Math.trunc(requestedTimeoutMs), MAX_TIMEOUT_MS))
    : DEFAULT_TIMEOUT_MS;

  async function send(sessionId: string, input: z.input<typeof ControlFrameSchema>): Promise<void> {
    const frame = ControlFrameSchema.parse(input);
    const path = codexProviderControlPath(homePath, sessionId);
    try {
      const info = await lstat(path);
      if (!info.isSocket() || info.isSymbolicLink()) throw new Error("control_unavailable");
      const line = `${JSON.stringify(frame)}\n`;
      if (Buffer.byteLength(line, "utf8") > 64 * 1024) throw new Error("control_frame_limit");
      const signal = AbortSignal.timeout(timeoutMs);
      const response = await new Promise<z.infer<typeof ControlResponseSchema>>((resolve, reject) => {
        const socket = createConnection({ path });
        let responseText = "";
        let settled = false;
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        const fail = () => {
          if (settled) return;
          settled = true;
          cleanup();
          socket.destroy();
          reject(new Error("control_failed"));
        };
        const onAbort = () => fail();
        signal.addEventListener("abort", onAbort, { once: true });
        socket.setEncoding("utf8");
        socket.setTimeout(timeoutMs, fail);
        socket.once("error", fail);
        socket.once("connect", () => socket.end(line));
        socket.on("data", (chunk) => {
          responseText += chunk;
          if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) fail();
        });
        socket.once("end", () => {
          if (settled) return;
          try {
            const parsed = ControlResponseSchema.parse(JSON.parse(responseText));
            settled = true;
            cleanup();
            resolve(parsed);
          } catch (_error) {
            fail();
          }
        });
        socket.once("close", () => {
          if (!settled) fail();
        });
      });
      if (!response.ok) throw new Error("control_rejected");
    } catch (_error) {
      throw new Error("Codex control request failed");
    }
  }

  return {
    submitApproval(input) {
      return send(input.sessionId, {
        type: "approval",
        approvalId: input.approvalId,
        decision: input.decision,
        clientRequestId: input.clientRequestId,
      });
    },
    submitInput(input) {
      return send(input.sessionId, {
        type: "input",
        requestId: input.inputRequestId,
        structuredAnswers: input.structuredAnswers,
        clientRequestId: input.clientRequestId,
      });
    },
  };
}
