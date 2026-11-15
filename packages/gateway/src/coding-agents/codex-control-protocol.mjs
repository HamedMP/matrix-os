// Plain-Node control boundary. These frames authorize native control only; none establish routine source authority.
import { z } from "zod/v4";
import { PendingTurnSchema } from "./codex-runner-config.mjs";
import { CodexBrowserBindSchema, CodexBrowserStartSchema } from "./codex-browser-bootstrap.mjs";
import { CodexHibernateControlSchema, CodexExecutionIdleControlSchema } from "./codex-idle-hibernation.mjs";
import { CodexDeferredInputControlSchema } from "./codex-deferred-input.mjs";
const ApprovalDecisionSchema = z.enum(["approve", "approve_for_session", "decline", "cancel"]);

const ApprovalControlSchema = z.object({
  type: z.literal("approval"),
  approvalId: z.string().regex(/^appr_codex_[a-f0-9]{32}$/),
  decision: ApprovalDecisionSchema,
  clientRequestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();
const MatrixQuestionIdSchema = z.string().regex(/^question_codex_[a-f0-9]{24}$/);
const InputControlSchema = z.object({
  type: z.literal("input"),
  requestId: z.string().regex(/^req_codex_[a-f0-9]{32}$/),
  structuredAnswers: z.record(
    MatrixQuestionIdSchema,
    z.array(z.string().min(1).max(400).refine((value) => Buffer.byteLength(value, "utf8") <= 700))
      .min(1).max(4),
  ).superRefine((answers, context) => {
    const count = Object.keys(answers).length;
    if (count < 1 || count > 8) context.addIssue({ code: "custom", message: "Invalid answer count" });
  }),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const TurnControlSchema = PendingTurnSchema.extend({
  type: z.literal("turn"),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const InterruptControlSchema = z.object({
  type: z.literal("interrupt"),
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
const SteerControlSchema = z.object({
  type: z.literal("steer"),
  prompt: PendingTurnSchema.shape.prompt,
  clientRequestId: ApprovalControlSchema.shape.clientRequestId,
}).strict();
export const CodexControlSchema = z.discriminatedUnion("type", [
  CodexExecutionIdleControlSchema,
  CodexHibernateControlSchema,
  CodexBrowserBindSchema,
  CodexBrowserStartSchema,
  TurnControlSchema,
  SteerControlSchema,
  InterruptControlSchema,
  ApprovalControlSchema,
  InputControlSchema,
  CodexDeferredInputControlSchema,
]);
