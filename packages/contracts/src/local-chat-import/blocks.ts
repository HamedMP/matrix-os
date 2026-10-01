import { object, string, type ImportBlock } from "#local-chat-import/types";
const TEXT_TYPES = new Set(["text", "Text", "input_text", "output_text"]);
/** Explicit block traversal only: never interprets arbitrary strings as files or URLs. */
export function importBlocks(value: unknown, depth = 0): ImportBlock[] {
  if (depth > 32) throw new Error("Import content nesting exceeds limit");
  if (typeof value === "string") return value ? [{ kind: "text", text: value }] : [];
  if (!Array.isArray(value)) return [];
  if (value.length > 10_000) throw new Error("Import content block count exceeds limit");
  const result: ImportBlock[] = [];
  for (const raw of value) {
    const block = object(raw);
    const type = string(block.type) ?? "unknown";
    if (TEXT_TYPES.has(type) && typeof block.text === "string") {
      result.push({ kind: "text", text: block.text });
    } else if (type === "input_image") {
      const url = string(block.image_url);
      if (url) {
        const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(url);
        result.push(match ? { kind: "media", encoding: "base64", mediaType: match[1], data: match[2]! }
          : { kind: "media", encoding: "url", data: url });
      }
    } else if (type === "local_image" && typeof block.path === "string") {
      result.push({ kind: "media", encoding: "local", data: block.path });
    } else if (type === "image" || type === "document") {
      const source = object(block.source);
      if (source.type === "base64" && typeof source.data === "string") {
        result.push({ kind: "media", encoding: "base64", mediaType: string(source.media_type), data: source.data });
      } else if (source.type === "url" && typeof source.url === "string") {
        result.push({ kind: "media", encoding: "url", data: source.url });
      } else result.push({ kind: "opaque", type });
    } else if (type === "tool_result") {
      result.push(...importBlocks(block.content, depth + 1));
    } else result.push({ kind: "opaque", type });
    if (result.length > 10_000) throw new Error("Import content block count exceeds limit");
  }
  return result;
}
export function firstText(blocks: ImportBlock[]): string | undefined {
  return blocks.find((block): block is Extract<ImportBlock, { kind: "text" }> => block.kind === "text")?.text;
}
/** Recognized saved instruction envelopes are context, even when their provider role is user. */
export function isInjectedContext(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trimStart();
  return /^# AGENTS\.md instructions for [^\n]+\n[\s\S]*<INSTRUCTIONS>/.test(trimmed)
    || /^(?:<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*)?<environment_context>/.test(trimmed)
    || /^<recommended_plugins>[\s\S]*?<\/recommended_plugins>\s*# AGENTS\.md instructions for /.test(trimmed);
}
