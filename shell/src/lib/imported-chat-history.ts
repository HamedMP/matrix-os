import { importedChatAssetContentPath, isImportedChatContext, type CanonicalChatMessage, type CanonicalToolActivity } from "@matrix-os/contracts";
import type { ChatMessage } from "./chat";

export function importedAttachments(message: CanonicalChatMessage): NonNullable<ChatMessage["attachments"]> {
  return message.parts.flatMap((part, index) => {
    if (part.type !== "import_reference") return [];
    const importAsset = { chatId: message.chatId, assetId: part.assetId, label: part.label };
    return [{ id: `${message.id}:import:${index}`, label: part.label, kind: part.kind === "image" ? "image" as const : "file" as const,
      importAsset, ...(part.kind === "image" ? { src: importedChatAssetContentPath(importAsset) } : {}) }];
  });
}
/** Historical requests/results have no live Run; join them before projecting bubbles. */
export function importedToolProjector(messages: CanonicalChatMessage[]) {
  type Entry = { request?: Extract<CanonicalChatMessage["parts"][number], { type: "tool_request" }>; results: Extract<CanonicalChatMessage["parts"][number], { type: "tool_result" }>[]; messages: CanonicalChatMessage[] };
  const links = new Map<string, Entry>();
  const MAX_TOOL_LINKS = 10_000;
  for (const message of messages) {
    if (!message.parts.some(part => part.type === "import_provenance")) continue;
    for (const part of message.parts) {
      if (part.type !== "tool_request" && part.type !== "tool_result") continue;
      if (!links.has(part.toolCallId) && links.size >= MAX_TOOL_LINKS) links.delete(links.keys().next().value!);
      const entry = links.get(part.toolCallId) ?? { results: [], messages: [] };
      if (part.type === "tool_request") entry.request = part;
      else if (entry.results.length < 64) entry.results.push(part);
      if (entry.messages.length < 64 && !entry.messages.includes(message)) entry.messages.push(message);
      links.set(part.toolCallId, entry);
    }
  }
  const emitted = new Set<string>(); // Capped by links; scoped to this projection.
  return (message: CanonicalChatMessage): ChatMessage[] | null => {
    if (!message.parts.some(part => part.type === "import_provenance")) return null;
    const text = message.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
    if (message.role === "user" && isImportedChatContext(text)) return [{ id: message.id, role: "system", tool: "Imported instructions", content: "Saved instructions", timestamp: Date.parse(message.createdAt),
      toolDisplay: { id: message.id, kind: "context", state: "completed", label: "Imported instructions", detail: text }, attachments: importedAttachments(message) }];
    const tools = message.parts.filter(part => part.type === "tool_request" || part.type === "tool_result");
    if (!tools.length) return null;
    return tools.flatMap(part => {
      if (emitted.has(part.toolCallId)) return [];
      const entry = links.get(part.toolCallId);
      if (!entry) return [];
      emitted.add(part.toolCallId);
      const state = entry.results.some(result => result.outcome === "failed") ? "failed"
        : entry.results.some(result => result.outcome === "cancelled") ? "stopped"
        : entry.results.length ? "completed" : "partial";
      const label = entry.request?.label ?? "Tool result";
      const detail = [entry.request?.inputPreview, ...entry.results.map(result => result.text)].filter(Boolean).join("\n\n");
      const toolDisplay: CanonicalToolActivity = { id: part.toolCallId, kind: "tool", state, label,
        ...(entry.request?.inputPreview ? { preview: entry.request.inputPreview, previewKind: "text" } : {}), ...(detail ? { detail } : {}) };
      return [{ id: `${message.id}:${part.toolCallId}`, role: "system" as const, tool: label, toolDisplay,
        content: `${state === "partial" ? "Incomplete" : "Used"} ${label}`, timestamp: Date.parse(message.createdAt),
        attachments: entry.messages.flatMap(importedAttachments) }];
    });
  };
}
