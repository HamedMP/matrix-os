import type { LocalChatgptPlanClient } from "@matrix-os/ui";
import { ChatgptPlanSessionSchema, ChatgptPlanStatusSchema, type ChatgptPlanSession } from "../../../../shared/chatgpt-plan-ipc.js";

/** Owner-device IPC carries no model bearer or native CLI credentials to the renderer. */
export function createDesktopChatgptPlanClient(session: ChatgptPlanSession, isCurrent: () => boolean,
  call: (channel: string, payload: unknown) => Promise<unknown> = (channel, payload) => window.operator.invoke(channel, payload),
  onCatalogChanged?: () => void,
): LocalChatgptPlanClient {
  const binding = ChatgptPlanSessionSchema.parse(session);
  let requestSequence = 0;
  let mutationSequence = 0;
  let appliedRequest = 0;
  let observedAuthority: string | null | undefined;
  async function request(channel: string, signal: AbortSignal, input: Record<string, unknown> = {}) {
    const requestId = ++requestSequence;
    const mutation = channel === "chatgpt-plan:status" ? mutationSequence : ++mutationSequence;
    try {
      if (signal.aborted || !isCurrent()) throw new Error("obsolete");
      const value = await call(channel, { ...binding, ...input });
      if (signal.aborted || !isCurrent()) throw new Error("obsolete");
      const status = ChatgptPlanStatusSchema.parse(value);
      if (mutation === mutationSequence && requestId >= appliedRequest) {
        appliedRequest = requestId;
        const authority = status.state === "connected" && status.account && status.bridgeConnected
          && status.grant.enabled && status.revocation !== "unconfirmed"
          ? JSON.stringify([status.account.id, status.grant.revision, status.models]) : null;
        // Initial presentation is a baseline. Only a changed accepted receipt
        // (or an immediately successful Connect) wakes open Chat consumers.
        const changed = observedAuthority !== undefined ? authority !== observedAuthority
          : channel !== "chatgpt-plan:status" && authority !== null;
        observedAuthority = authority;
        if (changed) onCatalogChanged?.();
      }
      return status;
    } catch (caught) {
      console.warn("[chatgpt-plan] Native request unavailable:", caught instanceof Error ? caught.name : typeof caught);
      throw new Error("ChatGPT connection is unavailable. Check again.");
    }
  }
  return {
    status: signal => request("chatgpt-plan:status", signal),
    connect: (input, signal) => request("chatgpt-plan:connect", signal, input),
    rebind: (input, signal) => request("chatgpt-plan:rebind", signal, input),
    cancel: signal => request("chatgpt-plan:cancel", signal),
    disconnect: signal => request("chatgpt-plan:disconnect", signal),
    refreshModels: signal => request("chatgpt-plan:refresh-models", signal),
    setGrant: (input, signal) => request("chatgpt-plan:set-grant", signal, input),
  };
}
