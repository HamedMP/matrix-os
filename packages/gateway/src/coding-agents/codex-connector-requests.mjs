import { z } from "zod/v4";
import { compileElicitation } from "./codex-elicitation.mjs";
import { cancel } from "./codex-request-expiry.mjs";

const Envelope = z.object({ id: z.union([z.string().min(1).max(128), z.number().int().safe()]), method: z.string().min(1).max(160) });

/** Bounded pending consent. Unknown server requests always receive a JSON-RPC error. */
export function createConnectorRequests({ send, persist, safeText, scope, now = Date.now }) {
  const pending = new Map(); // Cap 20; five-minute expiry and explicit turn/shutdown drain.
  return {
    async handle(raw) {
      const envelope = Envelope.safeParse(raw);
      if (!envelope.success) return false;
      const { id, method } = envelope.data;
      if (method !== "mcpServer/elicitation/request") {
        send({ id, error: { code: -32601, message: "This request is not supported." } });
        return true;
      }
      let form;
      const current = scope();
      try { form = compileElicitation(raw, safeText, current.turnId); }
      catch (error) {
        if (!(error instanceof Error)) throw error;
        console.warn("[coding-agents] unsupported connector request");
        send({ id, error: { code: -32602, message: "This connector form is not supported." } });
        return true;
      }
      if (pending.has(form.requestId)) return true;
      if (!current.turnId || form.threadId !== current.threadId || (form.turnId && form.turnId !== current.turnId)
        || pending.size >= 20) {
        send({ id, result: { action: "cancel", content: null, _meta: null } });
        return true;
      }
      pending.set(form.requestId, { id, form, expiresAt: now() + 300_000 });
      try {
        await persist({ type: "matrix.codex.user_input.requested", requestId: form.requestId,
          correlationId: form.correlationId, title: "Connector request", safeDescription: "Review this connector request before continuing.",
          questions: form.questions, required: false, connectorActionId: form.actionId,
          ...(form.connectorUrl ? { connectorUrl: form.connectorUrl } : {}),
        });
      } catch (error) {
        pending.delete(form.requestId);
        send({ id, result: { action: "cancel", content: null, _meta: null } });
        throw error;
      }
      return true;
    },
    answer(requestId, answers) {
      const entry = pending.get(requestId);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) return false;
      const result = entry.form.respond(answers);
      if (!result) return false;
      send({ id: entry.id, result });
      pending.delete(requestId);
      return true;
    },
    async expire(all = false, reply = true) {
      const events = [];
      for (const [requestId, entry] of pending) {
        if (!all && entry.expiresAt > now()) continue;
        pending.delete(requestId);
        if (reply) cancel(send, { id: entry.id, result: { action: "cancel", content: null, _meta: null } });
        events.push({ type: "matrix.codex.user_input.resolved", requestId, correlationId: entry.form.correlationId });
      }
      for (const event of events) await persist(event);
    },
  };
}
