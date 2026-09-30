import { CodexReconstruction } from "#local-chat-import/codex";
import { projectClaude } from "#local-chat-import/claude";
import { string, type ImportHarness, type ImportProjection, type ImportSource } from "#local-chat-import/types";
import type { LocalChatSourceEntry } from "#local-chat-import/jsonl";
/** Streaming source reconstruction; downstream durable staging applies fragment/mirror semantics. */
export async function* reconstructLocalChat(harness: ImportHarness, records: AsyncIterable<LocalChatSourceEntry>): AsyncGenerator<ImportProjection> {
  if (harness !== "codex" && harness !== "claude") throw new Error("Unsupported import harness");
  const codex = new CodexReconstruction();
  for await (const record of records) {
    const source: ImportSource = { line: record.line, offset: record.offset, end: record.end };
    if (record.kind === "issue") {
      yield { kind: "issue", source, conversation: { harness }, code: record.code };
      continue;
    }
    source.timestamp = string(record.value.timestamp);
    source.recordId = string(record.value.uuid);
    source.parentRecordId = string(record.value.parentUuid);
    if (Number.isSafeInteger(record.value.ordinal) && typeof record.value.ordinal === "number") source.ordinal = record.value.ordinal;
    const projected = harness === "codex" ? await codex.project(record.value, source) : projectClaude(record.value, source);
    for (const event of projected) yield event;
  }
}
