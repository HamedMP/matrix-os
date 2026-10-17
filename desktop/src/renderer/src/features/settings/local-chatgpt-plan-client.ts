import type { LocalChatgptPlanClient } from "@matrix-os/ui";
import { ChatgptPlanSessionSchema, ChatgptPlanStatusSchema, ChatgptPlanStatusResponseSchema,
  type ChatgptPlanDiagnostic, type ChatgptPlanSession } from "../../../../shared/chatgpt-plan-ipc.js";

type DesktopChatgptPlanClient = LocalChatgptPlanClient & {
  /** Pure cached metadata; never invokes IPC, auth, storage or the provider. */
  getLastDiagnostic(): ChatgptPlanDiagnostic | null;
};
/** Owner-device IPC carries no model bearer or native CLI credentials to the renderer. */
export function createDesktopChatgptPlanClient(session: ChatgptPlanSession, isCurrent: () => boolean,
  call: (channel: string, payload: unknown) => Promise<unknown> = (channel, payload) => window.operator.invoke(channel, payload),
): DesktopChatgptPlanClient {
  const binding = ChatgptPlanSessionSchema.parse(session);
  let requestRevision = 0;
  let diagnostic: ChatgptPlanDiagnostic | null = null;
  let release: (() => void) | undefined;
  function clearDiagnostic() { diagnostic = null; release?.(); release = undefined; }
  function retain(value: ChatgptPlanDiagnostic, signal: AbortSignal) {
    clearDiagnostic(); diagnostic = Object.freeze({ ...value });
    signal.addEventListener("abort", clearDiagnostic, { once: true });
    release = () => signal.removeEventListener("abort", clearDiagnostic);
  }
  async function request(channel: string, signal: AbortSignal, input: Record<string, unknown> = {}) {
    const revision = ++requestRevision;
    clearDiagnostic();
    let awaitingTransport = false;
    try {
      if (signal.aborted || !isCurrent()) throw new Error("obsolete");
      awaitingTransport = true;
      const value = await call(channel, { ...binding, ...input });
      awaitingTransport = false;
      if (signal.aborted || !isCurrent() || revision !== requestRevision) throw new Error("obsolete");
      if (channel === "chatgpt-plan:status") {
        const result = ChatgptPlanStatusResponseSchema.parse(value);
        if ("kind" in result) {
          retain(result.diagnostic, signal);
          if (result.kind === "status_failure") throw new Error("status unavailable");
          return result.status;
        }
        clearDiagnostic();
        return result;
      }
      const result = ChatgptPlanStatusSchema.parse(value);
      clearDiagnostic();
      return result;
    } catch (caught) {
      if (channel === "chatgpt-plan:status" && awaitingTransport && revision === requestRevision && !signal.aborted && isCurrent()) {
        retain({ phase: "transport", category: "unavailable", at: new Date().toISOString(), correlationId: crypto.randomUUID() }, signal);
      }
      if (revision === requestRevision && (signal.aborted || !isCurrent())) clearDiagnostic();
      console.warn("[chatgpt-plan] Native request unavailable:", caught instanceof Error ? "request_failed" : "unknown");
      throw new Error("ChatGPT connection is unavailable. Check again.");
    }
  }
  return {
    getLastDiagnostic: () => { if (!isCurrent()) clearDiagnostic(); return diagnostic; },
    status: signal => request("chatgpt-plan:status", signal),
    connect: (input, signal) => request("chatgpt-plan:connect", signal, input),
    rebind: (input, signal) => request("chatgpt-plan:rebind", signal, input),
    cancel: signal => request("chatgpt-plan:cancel", signal),
    disconnect: signal => request("chatgpt-plan:disconnect", signal),
    refreshModels: signal => request("chatgpt-plan:refresh-models", signal),
    setGrant: (input, signal) => request("chatgpt-plan:set-grant", signal, input),
  };
}
