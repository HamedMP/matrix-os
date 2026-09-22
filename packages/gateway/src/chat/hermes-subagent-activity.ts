import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { ChatSubagent } from "@matrix-os/contracts";
import { safeCodexSubagentText } from "../coding-agents/codex-tool-output.mjs";
import type { CanonicalProviderRunEvent } from "./provider-adapter.js";

const payloadSchema = z.object({
  subagent_id: z.string().min(1).max(256).optional(),
  delegation_id: z.string().min(1).max(256).optional(),
  task_index: z.number().int().min(0).max(10_000).optional(),
  goal: z.unknown().optional(), summary: z.unknown().optional(),
  status: z.string().max(80).optional(),
});
const opaque = (value: string) => `agent_${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
type Activity = Extract<CanonicalProviderRunEvent, { type: "agent.activity" }>;

/** Run-scoped, bounded projection of observed children; no native IDs or inferred roles. */
export function createHermesSubagentActivity(parent: string) {
  const children = new Map<string, ChatSubagent>();
  return (type: string, payload: unknown): Activity | undefined => {
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) return;
    const data = parsed.data;
    const starting = type === "subagent.start" || type === "subagent.spawn_requested";
    if (!starting && type !== "subagent.complete") return;
    // Legacy completion without identity is safe only when exactly one child exists.
    const key = data.subagent_id ? `id:${data.subagent_id}`
      : data.delegation_id && data.task_index !== undefined ? `task:${data.delegation_id}:${data.task_index}`
      : data.task_index !== undefined ? `legacy:${data.task_index}`
      : !starting && children.size === 1 ? children.keys().next().value : undefined;
    if (!key) return;
    const prior = children.get(key);
    if (!starting && !prior) return;
    if (!prior && children.size >= 128) children.delete(children.keys().next().value!);
    const status: ChatSubagent["status"] = starting ? prior?.status ?? "running"
      : ["completed", "complete", "success", "succeeded"].includes(data.status?.toLowerCase() ?? "") ? "completed"
      : ["cancelled", "canceled", "aborted", "interrupted"].includes(data.status?.toLowerCase() ?? "") ? "cancelled"
      : ["failed", "error", "errored"].includes(data.status?.toLowerCase() ?? "") ? "failed" : "unknown";
    const task = safeCodexSubagentText(data.goal, 1_000);
    const result = status === "completed" ? safeCodexSubagentText(data.summary, 2_000) : undefined;
    const subagent: ChatSubagent = {
      agentId: opaque(key), parentAgentId: opaque(parent),
      name: data.task_index !== undefined ? `Subagent ${data.task_index + 1}` : "Subagent",
      ...prior, ...(task ? { task } : {}), status,
      ...(!starting ? { result } : {}),
    };
    children.set(key, subagent);
    return {
      type: "agent.activity", activityId: opaque(`${parent}:${key}`), kind: "delegation",
      label: subagent.name, status: status === "unknown" ? "completed" : status === "waiting" ? "running" : status,
      subagent,
    };
  };
}
