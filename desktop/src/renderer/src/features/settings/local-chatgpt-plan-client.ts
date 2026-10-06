import type { LocalChatgptPlanClient } from "@matrix-os/ui";
import { ChatgptPlanSessionSchema, ChatgptPlanStatusSchema, type ChatgptPlanSession } from "../../../../shared/chatgpt-plan-ipc.js";

/** Owner-device IPC carries no model bearer or native CLI credentials to the renderer. */
export function createDesktopChatgptPlanClient(session: ChatgptPlanSession, isCurrent: () => boolean,
  call: (channel: string, payload: unknown) => Promise<unknown> = (channel, payload) => window.operator.invoke(channel, payload),
): LocalChatgptPlanClient {
  const binding = ChatgptPlanSessionSchema.parse(session);
  async function request(channel: string, signal: AbortSignal, input: Record<string, unknown> = {}) {
    try {
      if (signal.aborted || !isCurrent()) throw new Error("obsolete");
      const value = await call(channel, { ...binding, ...input });
      if (signal.aborted || !isCurrent()) throw new Error("obsolete");
      return ChatgptPlanStatusSchema.parse(value);
    } catch (caught) {
      console.warn("[chatgpt-plan] Native request unavailable:", caught instanceof Error ? caught.name : typeof caught);
      throw new Error("ChatGPT connection is unavailable. Check again.");
    }
  }
  return {
    status: signal => request("chatgpt-plan:status", signal),
    connect: (input, signal) => request("chatgpt-plan:connect", signal, input),
    cancel: signal => request("chatgpt-plan:cancel", signal),
    disconnect: signal => request("chatgpt-plan:disconnect", signal),
    refreshModels: signal => request("chatgpt-plan:refresh-models", signal),
    setGrant: (input, signal) => request("chatgpt-plan:set-grant", signal, input),
  };
}
