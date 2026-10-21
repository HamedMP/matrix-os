import { randomUUID } from "node:crypto";
import {
  canonicalChatApprovalTitle,
  supervisedToolApprovalCopy,
  type CanonicalChatApprovalDecision,
} from "@matrix-os/contracts";
import type { CustomMcpApprovalClient } from "./custom-mcp-approval-client.js";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import { safePublishedText } from "./safe-activity-projection.js";

const PENDING_LIMIT = 16;
const INPUT_LIMIT = 4_000;
export const CLAUDE_BUILTIN_TOOL_APPROVAL_TTL_MS = 10 * 60_000;
const DECLINED = "The owner declined this tool request.";
const EXPIRED = "This tool request expired before a decision.";
const CANCELLED = "This tool request was cancelled.";
const UNAVAILABLE = "Tool approval is unavailable in this Chat connection.";
// One-time decisions only: a remembered grant needs a Platform signature for approve_for_session first.
const DECISIONS = ["approve", "decline", "cancel"] as const satisfies readonly CanonicalChatApprovalDecision[];

type Respond = (value: unknown) => Promise<void>;
interface Pending {
  nativeId: string;
  input: Record<string, unknown>;
  respond: Respond;
  timer: ReturnType<typeof setTimeout>;
  deciding?: Promise<void>;
  expireAfterDecision?: boolean;
}

// Stricter than the shared preview rule: any assignment or flag whose name mentions a credential
// (AWS_SECRET_ACCESS_KEY=, GITHUB_TOKEN=, --password) hides the text. False positives only hide details.
const CREDENTIAL_NAME = /[A-Za-z0-9_-]*(?:key|token|secret|passw(?:or)?d|credential|auth)[A-Za-z0-9_-]*\s*[:=]|--?(?:key|token|secret|passw(?:or)?d|credential|auth)[A-Za-z0-9_-]*\b/i;

/** Agent-written text the approval card may show, or undefined when it could carry a secret. */
function cardText(value: string, homePath: string, maxChars: number): string | undefined {
  if (CREDENTIAL_NAME.test(value)) return undefined;
  return safePublishedText(value, { homePath, maxChars });
}

function toolSubject(input: Record<string, unknown>, homePath: string): string | undefined {
  const raw = input.query ?? input.url ?? input.command ?? input.file_path ?? input.path;
  if (typeof raw !== "string") return undefined;
  // Secret-looking text is dropped whole, never partially redacted.
  const safe = cardText(raw, homePath, INPUT_LIMIT);
  if (!safe) return undefined;
  const subject = safe.replace(/\s+/g, " ").trim().slice(0, 80).replaceAll("\"", "'");
  return subject.length > 0 ? subject : undefined;
}

/** Owner-facing name for a Claude built-in tool. Internal ids stay off the prompt. */
export function claudeBuiltinToolApprovalCopy(toolName: string): { title: string; risk: "low" | "medium" | "high" } {
  const copy = supervisedToolApprovalCopy(toolName);
  return { title: copy.title, risk: copy.risk };
}

export function createClaudeBuiltinToolApprovalControl(options: {
  runId: string;
  chatId: string;
  homePath: string;
  verify: NonNullable<CustomMcpApprovalClient["verifyIntegrationDecision"]>;
  emit(event: CanonicalProviderRunEvent): void;
  onError(error: unknown): void;
}) {
  const pending = new Map<string, Pending>(); // max 16; resolved, expired, and closed entries are removed
  let closed = false;

  function warn(error: unknown) {
    console.warn("[chat-claude] Built-in tool approval failed", error instanceof Error ? error.name : "UnknownError");
    options.onError(error);
  }
  function deny(respond: Respond, message: string) {
    void respond({ behavior: "deny", message }).catch(warn);
  }
  function forget(id: string, current: Pending): boolean {
    if (pending.get(id) !== current) return false;
    clearTimeout(current.timer);
    pending.delete(id);
    return true;
  }
  function resolved(id: string, decision: CanonicalChatApprovalDecision, reason?: "expired") {
    options.emit(CanonicalProviderRunEventSchema.parse({
      type: "approval.resolved", approvalId: id, decision, ...(reason ? { reason } : {}),
    }));
  }
  function finish(id: string, current: Pending, decision: CanonicalChatApprovalDecision, message: string, reason?: "expired") {
    if (!forget(id, current)) return;
    deny(current.respond, message);
    resolved(id, decision, reason);
  }

  return {
    has(id: string) { return pending.has(id); },
    onToolPermission(request: { nativeRequestId: string; toolName: string; input: Record<string, unknown> }, respond: Respond): boolean {
      if (request.toolName.startsWith("mcp__") || request.toolName === "AskUserQuestion") return false;
      const duplicate = [...pending.values()].some(value => value.nativeId === request.nativeRequestId);
      if (duplicate) return true;
      const raw = JSON.stringify(request.input);
      const copy = supervisedToolApprovalCopy(request.toolName);
      if (closed || pending.size >= PENDING_LIMIT || raw.length > INPUT_LIMIT) {
        deny(respond, UNAVAILABLE);
        return true;
      }
      const subject = toolSubject(request.input, options.homePath)?.replace(/^https?:\/\//i, "");
      const titled = subject ? `${copy.title} · “${subject}”` : copy.title;
      const safeTitle = canonicalChatApprovalTitle(titled);
      const title = safeTitle === titled ? titled : canonicalChatApprovalTitle(copy.title);
      // The whole input is checked before any of it is shown: one secret anywhere hides all details.
      const room = Math.max(0, INPUT_LIMIT - copy.summary.length - 2);
      const details = room > 0 ? cardText(raw, options.homePath, room) ?? "" : "";
      const safeDescription = details && details !== "{}" ? `${copy.summary}\n\n${details}` : copy.summary;
      const id = `tool_${randomUUID()}`;
      const current: Pending = {
        nativeId: request.nativeRequestId,
        input: structuredClone(request.input),
        respond,
        timer: setTimeout(() => {
          if (current.deciding) {
            current.expireAfterDecision = true;
            return;
          }
          finish(id, current, "cancel", EXPIRED, "expired");
        }, CLAUDE_BUILTIN_TOOL_APPROVAL_TTL_MS),
      };
      current.timer.unref?.();
      pending.set(id, current);
      options.emit(CanonicalProviderRunEventSchema.parse({
        type: "approval.requested", approvalId: id,
        title, safeDescription, risk: copy.risk,
        allowedDecisions: [...DECISIONS],
      }));
      return true;
    },
    onToolPermissionCancel(nativeId: string) {
      for (const [id, current] of pending) if (current.nativeId === nativeId && !current.deciding) finish(id, current, "cancel", CANCELLED);
    },
    async submit(id: string, decision: CanonicalChatApprovalDecision, provenance?: {
      chatId: string; clientRequestId: string; platformApprovalProof?: string;
    }) {
      const current = pending.get(id);
      if (!provenance?.platformApprovalProof || provenance.chatId !== options.chatId) {
        throw new Error("Authenticated approval proof unavailable");
      }
      if (!current || closed || current.deciding || !(DECISIONS as readonly string[]).includes(decision)) {
        throw new Error("Approval unavailable");
      }
      const provenDecision = decision as typeof DECISIONS[number];
      const proof = provenance.platformApprovalProof;
      const clientRequestId = provenance.clientRequestId;
      current.deciding = (async () => {
        let responded = false;
        try {
          const verified = await options.verify({
            chatId: options.chatId, runId: options.runId, approvalId: id,
            decision: provenDecision, clientRequestId, platformApprovalProof: proof,
          });
          if (!verified || closed || pending.get(id) !== current) throw new Error("Authenticated approval proof unavailable");
          responded = true;
          await current.respond(provenDecision === "approve"
            ? { behavior: "allow", updatedInput: current.input }
            : { behavior: "deny", message: provenDecision === "decline" ? DECLINED : CANCELLED });
          if (!forget(id, current)) return;
          resolved(id, provenDecision);
        } catch (error: unknown) {
          if (!responded && pending.get(id) === current) {
            current.deciding = undefined;
            if (current.expireAfterDecision) finish(id, current, "cancel", EXPIRED, "expired");
          } else if (forget(id, current)) resolved(id, "cancel");
          if (responded) warn(error);
          throw error;
        }
      })();
      await current.deciding;
    },
    close() {
      closed = true;
      for (const [id, current] of [...pending]) finish(id, current, "cancel", UNAVAILABLE);
    },
  };
}
