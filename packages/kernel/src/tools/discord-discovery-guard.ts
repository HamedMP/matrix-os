import type { CallServiceInput, ToolResult } from "./integrations.js";

const MAX_PENDING_DISCOVERIES = 128;
const blocked = (): ToolResult => ({ isError: true, content: [{ type: "text", text:
  "Message reading is blocked after incomplete or failed channel discovery. Retry channel discovery for the same account and server successfully before reading messages." }] });

/** One instance per owner agent run. Never share failure state across owners or runs. */
export function createDiscordDiscoveryGuard(
  call: (input: CallServiceInput) => Promise<ToolResult>,
): (input: CallServiceInput) => Promise<ToolResult> {
  // Successful discovery evicts its entry; failures remain until that server is
  // retried or the run ends. At the cap, new discovery fails closed.
  const discoveries = new Map<string, { service: string; label: string | null; pending: boolean }>();
  let saturated = false;
  return async (input) => {
    if (input.service !== "discord" && input.service !== "discord_bot") return call(input);
    if (saturated) return { isError: true, content: [{ type: "text", text:
      "Too many failed channel discoveries in this run. Start a new run before reading messages." }] };
    const label = input.label?.trim() || null;
    const selection = JSON.stringify([input.service, label]);
    // An unlabeled call can resolve to any first active account. Refuse aliases
    // conservatively rather than guessing which account the gateway selected.
    if (input.action === "list_messages" && [...discoveries.values()].some(item =>
      item.service === input.service && (label === null || item.label === null || item.label === label))) return blocked();
    if (input.action !== "list_channels") return call(input);
    const key = JSON.stringify([selection, input.params?.serverId ?? null]);
    if (discoveries.get(key)?.pending) return blocked();
    if (!discoveries.has(key) && discoveries.size >= MAX_PENDING_DISCOVERIES) {
      saturated = true;
      return blocked();
    }
    const entry = { service: input.service, label, pending: true };
    discoveries.set(key, entry);
    try {
      const result = await call(input);
      if (!result.isError) discoveries.delete(key);
      return result;
    } finally {
      // A thrown transport error also leaves this discovery blocked.
      entry.pending = false;
    }
  };
}
