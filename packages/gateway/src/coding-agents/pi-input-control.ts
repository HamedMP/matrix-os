import { randomUUID } from "node:crypto";
import { AgentThreadEventSchema, UserInputRequestSchema, buildCanonicalChatInputAnswer, type AgentThreadEvent, type UserInputAnswerRequest } from "@matrix-os/contracts";
import { logCodingAgentWarning } from "./diagnostics.js";
import { z } from "zod/v4";

const DialogSchema = z.object({
  type: z.literal("extension_ui_request"), id: z.string().min(1).max(128),
  method: z.enum(["select", "confirm", "input", "editor"]),
  title: z.string().min(1).max(600), options: z.array(z.string().min(1).max(160)).min(1).max(10).optional(),
  message: z.string().max(600).optional(), timeout: z.number().int().positive().max(600_000).optional(),
});

/** At most eight native dialogs per live run; clear timers and controls on every exit path. */
export function createPiInputControl(options: {
  threadId: string; now: () => Date; nextEventId: () => string;
  write: (frame: Record<string, unknown>) => void; emit: (events: AgentThreadEvent[]) => void;
}) {
  const pending = new Map<string, { nativeId: string; method: string; request: ReturnType<typeof UserInputRequestSchema.parse>; timer: ReturnType<typeof setTimeout> }>();
  const nativeIds = new Set<string>();
  let accepted = 0;
  const base = () => ({ threadId: options.threadId, eventId: options.nextEventId(), occurredAt: options.now().toISOString() });
  return {
    receive(value: unknown): boolean {
      const parsed = DialogSchema.safeParse(value);
      if (!parsed.success) return false;
      const dialog = parsed.data;
      if (nativeIds.has(dialog.id)) return true;
      if (pending.size >= 8 || accepted >= 64) { options.write({ type: "extension_ui_response", id: dialog.id, cancelled: true }); return true; }
      const requestId = `req_${randomUUID().replaceAll("-", "")}`;
      const duration = Math.min(dialog.timeout ?? 240_000, 240_000);
      const choices = dialog.method === "confirm" ? ["Yes", "No"] : dialog.method === "select" ? dialog.options : undefined;
      const request = UserInputRequestSchema.safeParse({ requestId, threadId: options.threadId,
        title: "Input requested", safeDescription: dialog.message ?? dialog.title,
        correlationId: `corr_${requestId.slice(4)}`, expiresAt: new Date(options.now().getTime() + duration).toISOString(),
        questions: [{ questionId: "question", header: "Question", question: dialog.title,
          ...(choices ? { options: choices.map(label => ({ label, description: "Select this option" })) } : {}),
          allowOther: !choices, secret: false, multiSelect: false }],
      });
      if (!request.success || (dialog.method === "select" && !choices)) {
        options.write({ type: "extension_ui_response", id: dialog.id, cancelled: true });
        return true;
      }
      const timer = setTimeout(() => {
        pending.delete(requestId); nativeIds.delete(dialog.id);
        try { options.write({ type: "extension_ui_response", id: dialog.id, cancelled: true }); }
        catch (error: unknown) { logCodingAgentWarning("pi expired input cancellation failed", error); }
        options.emit([AgentThreadEventSchema.parse({ ...base(), type: "user_input.answered", requestId, correlationId: request.data.correlationId, reason: "expired" })]);
      }, duration);
      timer.unref?.();
      pending.set(requestId, { nativeId: dialog.id, method: dialog.method, request: request.data, timer });
      nativeIds.add(dialog.id);
      accepted++;
      options.emit([AgentThreadEventSchema.parse({ ...base(), type: "user_input.requested", request: request.data })]);
      return true;
    },
    submit(requestId: string, answer: UserInputAnswerRequest): AgentThreadEvent[] {
      const entry = pending.get(requestId);
      if (!entry || answer.correlationId !== entry.request.correlationId || Date.parse(entry.request.expiresAt!) <= options.now().getTime()) throw new Error("Input request unavailable");
      const values = answer.structuredAnswers ?? { question: [answer.answer] };
      if (!buildCanonicalChatInputAnswer(entry.request, values)) throw new Error("Invalid input answer");
      const selected = values.question![0]!;
      options.write({ type: "extension_ui_response", id: entry.nativeId, ...(entry.method === "confirm" ? { confirmed: selected === "Yes" } : { value: selected }) });
      clearTimeout(entry.timer); pending.delete(requestId); nativeIds.delete(entry.nativeId);
      return [AgentThreadEventSchema.parse({ ...base(), type: "user_input.answered", requestId, correlationId: entry.request.correlationId })];
    },
    dispose() {
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear(); nativeIds.clear();
    },
  };
}
