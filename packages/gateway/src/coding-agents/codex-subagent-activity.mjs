import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { safeCodexSubagentText } from "./codex-tool-output.mjs";

const ref = z.string().min(1).max(512);
const markerSchema = z.object({
  type: z.literal("subAgentActivity"), id: ref,
  kind: z.enum(["started", "interacted", "interrupted", "completed"]),
  agentThreadId: ref, agentPath: z.string().max(512),
});
const collabSchema = z.object({
  type: z.literal("collabAgentToolCall"), senderThreadId: ref,
  receiverThreadIds: z.array(ref).max(128), prompt: z.string().max(64_000).nullable().optional(),
  agentsStates: z.record(ref, z.object({
    status: z.enum(["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"]),
    message: z.string().max(64_000).nullable().optional(),
  })).refine((states) => Object.keys(states).length <= 128).optional(),
});
const opaque = (...parts) => `agent_${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32)}`;
const terminal = new Set(["completed", "failed", "cancelled"]);

/** Per-run, bounded projection. Never reads arbitrary provider threads or emits child prose as parent output. */
export function createCodexSubagentActivity({ maxAgents = 128 } = {}) {
  const agents = new Map();
  const childTurns = new Map();
  let metadataBudget = 128;
  const metadataQueue = [];
  const metadataRechecked = new Set();
  const capacity = Number.isInteger(maxAgents) ? Math.max(1, Math.min(128, maxAgents)) : 128;
  function update(id, parent, turn, patch, create = false) {
    const prior = agents.get(id);
    if (!prior && !create) return [];
    if (!prior && agents.size >= capacity) {
      const oldest = agents.keys().next().value;
      agents.delete(oldest); childTurns.delete(oldest);
    }
    const subagent = { agentId: opaque(id), parentAgentId: opaque(parent), name: "Subagent", status: "unknown", ...prior?.subagent, ...patch };
    const next = { type: "matrix.codex.subagent.activity", activityId: opaque(turn, id), subagent };
    // A child can become visible before its persisted role metadata is readable.
    // One lifecycle-triggered recheck repairs that race without polling.
    if (prior && terminal.has(subagent.status) && !subagent.role
      && !metadataRechecked.has(id) && metadataRechecked.size < 128) {
      metadataRechecked.add(id); metadataQueue.push(id);
    }
    if (JSON.stringify(prior) === JSON.stringify(next)) return [];
    agents.set(id, next);
    if (!prior && metadataBudget > 0) { metadataBudget--; metadataQueue.push(id); }
    return [next];
  }
  return {
    get size() { return agents.size; },
    reset() { agents.clear(); childTurns.clear(); metadataQueue.length = 0; metadataBudget = 128; metadataRechecked.clear(); },
    takeMetadataRequests() { return metadataQueue.splice(0); },
    projectMetadata(id, thread, parent, turn) {
      const prior = agents.get(id);
      if (!prior || thread?.id !== id || typeof thread.parentThreadId !== "string"
        || opaque(thread.parentThreadId) !== prior.subagent.parentAgentId) return [];
      const role = safeCodexSubagentText(thread.agentRole, 80);
      return role ? update(id, parent, turn, { role }) : [];
    },
    project(raw, parent, turn) {
      if (!parent || !turn || !raw || typeof raw !== "object") return [];
      const params = raw.params;
      if (!params || typeof params !== "object") return [];
      const parentItem = ["item/started", "item/completed"].includes(raw.method)
        && ((params.threadId === parent && params.turnId === turn)
          || (agents.has(params.threadId) && childTurns.has(params.threadId) && childTurns.get(params.threadId) === params.turnId));
      if (parentItem) {
        const marker = markerSchema.safeParse(params.item);
        if (marker.success) {
          const item = marker.data;
          const name = safeCodexSubagentText(item.agentPath.split("/").filter(Boolean).at(-1), 120);
          const prior = agents.get(item.agentThreadId)?.subagent;
          if (item.agentThreadId === parent || item.agentThreadId === params.threadId) return [];
          return update(item.agentThreadId, params.threadId, turn, {
            ...(!prior && agents.get(params.threadId)?.subagent.name ? { parentName: agents.get(params.threadId).subagent.name } : {}),
            ...(name ? { name } : {}),
            ...(["completed", "interrupted"].includes(item.kind) ? { activity: undefined } : {}),
            // Completing the marker does not complete the delegated task.
            status: item.kind === "interrupted" ? "cancelled"
              : item.kind === "completed" ? terminal.has(prior?.status) ? prior.status : "completed"
              : prior?.status ?? "running",
          }, true);
        }
        const collab = collabSchema.safeParse(params.item);
        if (collab.success && collab.data.senderThreadId === params.threadId) {
          const item = collab.data;
          const task = safeCodexSubagentText(item.prompt, 1_000);
          return item.receiverThreadIds.flatMap((id) => {
            const state = item.agentsStates?.[id];
            const status = { pendingInit: "waiting", running: "running", interrupted: "cancelled",
              completed: "completed", errored: "failed", shutdown: "unknown", notFound: "unknown" }[state?.status];
            const result = state?.status === "completed" ? safeCodexSubagentText(state.message, 2_000) : undefined;
            if (id === parent || id === params.threadId) return [];
            return update(id, params.threadId, turn, { ...(task ? { task } : {}), ...(status ? { status, activity: undefined, ...(status !== "completed" ? { result: undefined } : {}) } : {}), ...(result ? { result } : {}) }, true);
          });
        }
      }
      // Metadata is display-only and must belong to an already attributed child.
      if (raw.method === "thread/started") {
        const id = params.thread?.id;
        if (!agents.has(id)) return [];
        const role = safeCodexSubagentText(params.thread?.agentRole, 80);
        return role ? update(id, parent, turn, { role }) : [];
      }
      const id = params.threadId;
      const prior = agents.get(id)?.subagent;
      if (!prior) return [];
      if (raw.method === "turn/started") {
        if (!ref.safeParse(params.turn?.id).success) return [];
        if (childTurns.get(id) === params.turn.id) return [];
        childTurns.set(id, params.turn.id);
        return update(id, parent, turn, { status: "running", result: undefined, activity: undefined });
      }
      const eventTurn = params.turnId ?? params.turn?.id;
      if (eventTurn && childTurns.has(id) && childTurns.get(id) !== eventTurn) return [];
      if (["item/started", "item/completed"].includes(raw.method)) {
        if (terminal.has(prior.status)) return [];
        const activity = { commandExecution: "Running a command", fileChange: "Editing files",
          webSearch: "Searching the web", mcpToolCall: "Using a tool", dynamicToolCall: "Using a tool",
          reasoning: "Thinking", agentMessage: "Writing a response" }[params.item?.type];
        if (activity) return update(id, parent, turn, { activity: raw.method === "item/started" ? activity : undefined });
      }
      if (raw.method === "thread/status/changed") {
        const state = params.status;
        if (state?.type === "systemError") return update(id, parent, turn, { status: "failed" });
        if (terminal.has(prior.status)) return [];
        if (state?.type === "idle" || state?.type === "notLoaded") return update(id, parent, turn, { status: "unknown" });
        if (state?.type === "active" && Array.isArray(state.activeFlags)) {
          return update(id, parent, turn, { status: state.activeFlags.some((flag) =>
            flag === "waitingOnApproval" || flag === "waitingOnUserInput") ? "waiting" : "running" });
        }
      }
      if (raw.method === "turn/completed") {
        const status = { completed: "completed", failed: "failed", interrupted: "cancelled" }[params.turn?.status];
        if (!status) return [];
        const items = Array.isArray(params.turn.items) ? params.turn.items.slice(-128) : [];
        const answer = items.filter((item) => item?.type === "agentMessage" && item.phase === "final_answer").at(-1);
        const result = status === "completed" ? safeCodexSubagentText(answer?.text, 2_000) : undefined;
        return update(id, parent, turn, { status, activity: undefined, result });
      }
      return [];
    },
  };
}
