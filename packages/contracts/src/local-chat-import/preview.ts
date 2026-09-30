import { LocalChatTransferError } from "#local-chat-import/client";
import { z } from "zod/v4";
import { readLocalChatJsonl, type LocalChatSourceEntry } from "#local-chat-import/jsonl";
import { reconstructLocalChat } from "#local-chat-import/reconstruct";
import { object, string, type ImportHarness, type ImportBlock } from "#local-chat-import/types";
const MAX_ENTRIES = 100_000;
export interface LocalChatImportCounts {
  humanInputs: number; assistantResponses: number; agentInputs: number; toolCalls: number; toolResults: number;
  attachments: number; externalReferences: number; thinkingRecords: number; contextRecords: number;
  unknownRecords: number; sourceIssues: number;
}
export interface LocalChatSourcePreview {
  harness: ImportHarness; sourceId: string; sourceAgentId?: string; sourceHash: string; rawBytes: number;
  title: string; firstVisibleText: string; recordedDirectory?: string; repositoryUrl?: string;
  counts: LocalChatImportCounts; parserVersion: 1;
}
export class LocalChatPreviewError extends Error {
  code: "invalid" | "source_changed" | "source_mismatch" | "projection_limit" | "no_readable_history";
  constructor(code: "invalid" | "source_changed" | "source_mismatch" | "projection_limit" | "no_readable_history") {
    super("Local Chat preview unavailable"); this.name = "LocalChatPreviewError"; this.code = code;
  }
}
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
function repositoryHint(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  try { const url = new URL(value); if (!["https:", "ssh:", "git:"].includes(url.protocol)) return undefined; url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.toString(); }
  catch (error: unknown) { if (!(error instanceof TypeError)) throw error; const safe=value.split(/[?#]/,1)[0]!; return /^git@[A-Za-z0-9.-]+:[^\s]+$/.test(safe) ? safe : undefined; }
}
/** Bounded counts and one local preview, never an in-memory copy of every message or private context. */
export async function previewLocalChatSource(harness: ImportHarness, input: {
  chunks: AsyncIterable<Uint8Array>; rawSize: number; sourceHash(): string | Promise<string>; signal?: AbortSignal;
}): Promise<LocalChatSourcePreview> {
  if (!["codex", "claude"].includes(harness) || !Number.isSafeInteger(input.rawSize) || input.rawSize < 1 || input.rawSize > 20 * 1024 ** 3) throw new LocalChatPreviewError("invalid");
  const counts: LocalChatImportCounts = { humanInputs: 0, assistantResponses: 0, agentInputs: 0, toolCalls: 0, toolResults: 0,
    attachments: 0, externalReferences: 0, thinkingRecords: 0, contextRecords: 0, unknownRecords: 0, sourceIssues: 0 };
  let sourceId: string | undefined; let sourceAgentId: string | undefined; let identitySeen = false;
  let recordedDirectory: string | undefined; let repositoryUrl: string | undefined; let firstVisibleText = ""; let sourceBytes = 0; let events = 0;
  // Preview lifetime only. Explicit 100k cap; the maps are released on return or rejection.
  const prose = new Map<string, { attachments: number; externalReferences: number }>();
  const calls = new Set<string>();
  async function* chunks() { for await (const bytes of input.chunks) { if (input.signal?.aborted) throw new LocalChatTransferError("cancelled"); sourceBytes += bytes.byteLength; if (sourceBytes > input.rawSize) throw new LocalChatPreviewError("source_changed"); yield bytes; } }
  async function* records(): AsyncGenerator<LocalChatSourceEntry> {
    for await (const record of readLocalChatJsonl(chunks(), { finalLine: "complete" })) {
      if (record.kind === "record") {
        const payload = object(record.value.payload); const cwd = string(record.value.cwd) ?? string(payload.cwd);
        if (!recordedDirectory && cwd && cwd.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(cwd)) recordedDirectory = cwd;
        repositoryUrl ??= repositoryHint(object(payload.git).repository_url);
      }
      yield record;
    }
  }
  function media(blocks: ImportBlock[]) {
    return { attachments: blocks.filter(block => block.kind === "media" && block.encoding === "base64").length,
      externalReferences: blocks.filter(block => block.kind === "media" && block.encoding !== "base64").length };
  }
  for await (const event of reconstructLocalChat(harness, records())) {
    if (++events > MAX_ENTRIES * 5) throw new LocalChatPreviewError("projection_limit");
    const readable = ["message", "tool_call", "tool_result", "context", "thinking", "compaction", "inter_agent", "notice"].includes(event.kind);
    const session = event.conversation.sessionId;
    if ((readable && !session) || (session && !z.uuid().safeParse(session).success)) throw new LocalChatPreviewError("source_mismatch");
    if (session) { if (sourceId && sourceId !== session) throw new LocalChatPreviewError("source_mismatch"); sourceId = session; }
    if (readable) {
      const agent = event.conversation.agentId;
      if (agent && (agent.length > 512 || /[\u0000-\u001f\u007f]/.test(agent))) throw new LocalChatPreviewError("source_mismatch");
      if (identitySeen && agent !== sourceAgentId) throw new LocalChatPreviewError("source_mismatch"); sourceAgentId = agent; identitySeen = true;
    }
    if (event.kind === "message") {
      const key = await digest(JSON.stringify([event.conversation, event.messageKey]));
      const prior = prose.get(key); const assets = media(event.blocks);
      if (!prior) {
        if (prose.size >= MAX_ENTRIES) throw new LocalChatPreviewError("projection_limit");
        if (event.origin === "human") counts.humanInputs++; else if (event.origin === "agent_task") counts.agentInputs++; else counts.assistantResponses++;
      } else if (event.mode === "replace_mirror") { counts.attachments -= prior.attachments; counts.externalReferences -= prior.externalReferences; }
      counts.attachments += assets.attachments; counts.externalReferences += assets.externalReferences;
      prose.set(key, event.mode === "replace_mirror" || !prior ? assets : { attachments: prior.attachments + assets.attachments, externalReferences: prior.externalReferences + assets.externalReferences });
      if (!firstVisibleText) firstVisibleText = event.blocks.filter((block): block is Extract<ImportBlock, { kind: "text" }> => block.kind === "text").map(block => block.text).join("\n\n").slice(0, 500);
    } else if (event.kind === "tool_call") {
      const key = await digest(JSON.stringify([event.conversation, event.callId]));
      if (!calls.has(key)) { if (calls.size >= MAX_ENTRIES) throw new LocalChatPreviewError("projection_limit"); calls.add(key); counts.toolCalls++; }
    } else if (event.kind === "tool_result") { counts.toolResults++; const assets = media(event.blocks); counts.attachments += assets.attachments; counts.externalReferences += assets.externalReferences; }
    else if (event.kind === "thinking") counts.thinkingRecords++;
    else if (["context", "compaction", "inter_agent", "bookkeeping"].includes(event.kind)) counts.contextRecords++;
    else if (event.kind === "unknown") counts.unknownRecords++;
    else if (event.kind === "issue") { if (event.code === "record_too_large") throw new LocalChatPreviewError("projection_limit"); counts.sourceIssues++; }
  }
  if (sourceBytes !== input.rawSize) throw new LocalChatPreviewError("source_changed");
  if (!sourceId || !identitySeen) throw new LocalChatPreviewError("source_mismatch");
  if (!(counts.humanInputs + counts.assistantResponses + counts.agentInputs + counts.toolCalls + counts.toolResults)) throw new LocalChatPreviewError("no_readable_history");
  const sourceHash = await input.sourceHash(); if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new LocalChatPreviewError("invalid");
  const title = firstVisibleText.split("\n")[0]!.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160) || `Imported ${harness === "codex" ? "Codex" : "Claude Code"} Chat`;
  return { harness, sourceId, ...(sourceAgentId ? { sourceAgentId } : {}), sourceHash, rawBytes: sourceBytes, title, firstVisibleText,
    ...(recordedDirectory ? { recordedDirectory } : {}), ...(repositoryUrl ? { repositoryUrl } : {}), counts, parserVersion: 1 };
}
