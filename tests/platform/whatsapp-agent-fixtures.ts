import { vi } from "vitest";
import { CanonicalCreateChatRequestSchema, CanonicalCreateChatTurnRequestSchema } from "@matrix-os/contracts";

export const time = "2026-10-02T12:00:00.000Z";
export const selection = { instanceId: "kernel_matrix_included", model: "matrix-model" };
export const supports = {
  rootChat: true, resume: true, cancellation: true, attachments: [], tools: [],
  approvals: true, userInput: true, worktrees: "none", resources: [],
  interactionModes: ["default"], permissionModes: ["supervised", "full_access"],
};
export function catalog(kind = "kernel", capabilityClass = "system_agent", permissionModes = supports.permissionModes) {
  return {
    revision: "catalog_1",
    drivers: [{ kind, displayName: "Matrix", adapterVersion: "1.0.0", capabilityClass }],
    instances: [{ id: selection.instanceId, driverKind: kind, displayName: "Matrix", availability: "available",
      workspaceRequirement: "none", catalogRevision: "catalog_1", models: [{ id: selection.model,
        displayName: "Matrix model", availability: "available", capabilities: [], supportsVision: false, supportsToolUse: false }],
      options: [], skills: [], commands: [], setupActions: [], defaultSelection: selection,
      supports: { ...supports, permissionModes } }],
  };
}
export function record(owner = "user_1", revision = 7) {
  return { chat: { id: "chat_whatsapp", ownerScope: { type: "personal", ownerId: owner }, title: "Matrix · WhatsApp",
    lifecycle: "active", attention: "none", revision, messageCount: 2, currentSelection: selection,
    createdAt: time, updatedAt: time } };
}
export function run(status = "accepted", id = "run_current") {
  const terminal = ["completed", "failed", "aborted"].includes(status);
  return { id, chatId: "chat_whatsapp", turnId: "cturn_current", attempt: 1, driverKind: "kernel",
    instanceId: selection.instanceId, selection, interactionMode: "default", permissionMode: "supervised",
    status, ...(status !== "accepted" ? { startedAt: time } : {}),
    ...(terminal ? { completedAt: time, outcome: status } : {}), historyBoundarySeq: 0,
    capabilitySnapshot: { revision: "catalog_1", ...supports }, createdAt: time, updatedAt: time };
}
export function message(id = "msg_input", role = "user", text = "Hello", runId?: string) {
  return { id, chatId: "chat_whatsapp", seq: role === "user" ? 1 : 2, role, state: "committed",
    turnId: "cturn_current", ...(runId ? { runId } : {}), parts: [{ type: "text", text }], createdAt: time };
}
export function turn(clientRequestId = "req_fixture") {
  return { id: "cturn_current", chatId: "chat_whatsapp", clientRequestId, baseMessageSeq: 0,
    inputMessageId: "msg_input", status: "accepted", createdAt: time, updatedAt: time };
}
export function detail(status?: string) {
  return { record: record(), messages: status ? [message(), message("msg_reply", "assistant", "Your answer", "run_current")] : [],
    turns: status ? [turn()] : [], runs: status ? [run(status)] : [], activities: [] };
}

/** Fake only the external owner gateway boundary; the real agent client parses
 * these contract fixtures and the test repository/service/routes stay real. */
export function createWhatsAppAgentApiFixture(owner: string, options: {
  reply?: string; status?: "completed" | "running" | "waiting_for_approval";
  permissionModes?: string[];
} = {}) {
  const target = { machineId: "machine_1", gatewayUrl: "https://runtime.example", token: "runtime-owner-token" };
  const calls: Array<{ url: string; init: RequestInit; body?: unknown }> = [];
  const permissionModes = options.permissionModes ?? ["full_access"];
  let admission: ReturnType<typeof CanonicalCreateChatTurnRequestSchema.parse> | undefined;
  let admissionCount = 0;
  const projectedRun = (status: string) => ({ ...run(status),
    permissionMode: admission?.permissionMode ?? permissionModes[0]!,
    capabilitySnapshot: { revision: "catalog_1", ...supports, permissionModes },
  });
  const fetcher = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
    if (calls.length >= 100) throw new Error("Fixture request limit exceeded");
    const url = new URL(String(request));
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url: String(url), init: init!, body });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${target.token}`) return new Response(null, { status: 401 });
    if (url.pathname === "/api/chat-providers") return Response.json(catalog("kernel", "system_agent", permissionModes));
    if (url.pathname === "/api/chats" && init?.method === "POST") {
      CanonicalCreateChatRequestSchema.parse(body);
      return Response.json(record(owner), { status: 201 });
    }
    if (url.pathname === "/api/chats/chat_whatsapp/turns" && init?.method === "POST") {
      const parsed = CanonicalCreateChatTurnRequestSchema.parse(body);
      if (admission && admission.clientRequestId !== parsed.clientRequestId) throw new Error("Fixture supports one admitted turn");
      const duplicate = Boolean(admission);
      admission ??= parsed;
      if (!duplicate) admissionCount++;
      const text = admission.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      return Response.json({ record: record(owner), message: message("msg_input", "user", text),
        turn: turn(admission.clientRequestId), run: projectedRun("accepted"),
        admission: duplicate ? "already_accepted" : "accepted" }, { status: 202 });
    }
    if (url.pathname === "/api/chats/chat_whatsapp" && init?.method === "GET") {
      if (!admission) return Response.json({ ...detail(), record: record(owner) });
      const text = admission.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
      return Response.json({ record: record(owner), messages: [message("msg_input", "user", text),
        message("msg_reply", "assistant", options.reply ?? "Your Matrix agent is here.", "run_current")],
      turns: [turn(admission.clientRequestId)], runs: [projectedRun(options.status ?? "completed")], activities: [] });
    }
    throw new Error("Unexpected canonical gateway fixture request");
  });
  const resolveTarget = vi.fn(async (requestedOwner: string) => requestedOwner === owner ? target : null);
  return { target, calls, fetcher, fetchImpl: fetcher as typeof fetch, resolveTarget,
    get admissionCount() { return admissionCount; } };
}
