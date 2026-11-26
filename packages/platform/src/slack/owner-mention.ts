import { SlackUserIdSchema } from "./types.js";

const MAX_TEXT = 40_000;
const MAX_BLOCKS = 50;
const MAX_NODES = 1_024;
// A list → section → styled user reaches nine JSON edges from the block array.
const MAX_DEPTH = 10;

type RecordValue = Record<string, unknown>;
type MentionResult = { valid: boolean; found: boolean };

function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Bound the entire supplied JSON, including fields we do not interpret. This also
// rejects cyclic input before the semantic traversal and never allocates a tree.
function boundedJson(value: unknown): boolean {
  let remainingNodes = MAX_NODES;
  let remainingText = MAX_TEXT;
  const visit = (node: unknown, depth: number): boolean => {
    if (--remainingNodes < 0 || depth > MAX_DEPTH) return false;
    if (typeof node === "string") {
      remainingText -= node.length;
      return remainingText >= 0;
    }
    if (node === null || typeof node === "boolean") return true;
    if (typeof node === "number") return Number.isFinite(node);
    if (Array.isArray(node)) {
      return node.length <= MAX_NODES && node.every(child => visit(child, depth + 1));
    }
    if (!record(node)) return false;
    let keyCount = 0;
    for (const key in node) {
      if (!Object.hasOwn(node, key)) continue;
      if (++keyCount > 32) return false;
      remainingText -= key.length;
      if (remainingText < 0 || !visit(node[key], depth + 1)) return false;
    }
    return true;
  };
  return visit(value, 0);
}

function validStyle(style: unknown): boolean {
  return style === undefined || (record(style) && Object.entries(style).every(([key, value]) =>
    ["bold", "italic", "strike", "code", "underline", "highlight", "client_highlight", "unlink"].includes(key)
      && typeof value === "boolean"));
}

function inlineElements(elements: unknown, target: string, active: boolean): MentionResult {
  if (!Array.isArray(elements)) return { valid: false, found: false };
  let found = false;
  for (const element of elements) {
    if (!record(element) || !validStyle(element.style)) return { valid: false, found: false };
    let valid: boolean;
    switch (element.type) {
      case "user":
        valid = SlackUserIdSchema.safeParse(element.user_id).success;
        found ||= valid && active && element.user_id === target
          && !(record(element.style) && element.style.code === true);
        break;
      case "text":
        valid = typeof element.text === "string";
        break;
      case "link":
        valid = typeof element.url === "string" && (element.text === undefined || typeof element.text === "string");
        break;
      case "emoji":
        valid = typeof element.name === "string";
        break;
      case "channel":
        valid = typeof element.channel_id === "string";
        break;
      case "usergroup":
        valid = typeof element.usergroup_id === "string";
        break;
      case "broadcast":
        valid = ["here", "channel", "everyone"].includes(String(element.range));
        break;
      default:
        return { valid: false, found: false };
    }
    if (!valid) return { valid: false, found: false };
  }
  return { valid: true, found };
}

function richTextMention(blocks: unknown, target: string): boolean {
  if (!Array.isArray(blocks) || blocks.length > MAX_BLOCKS || !boundedJson(blocks)) return false;
  let found = false;
  for (const block of blocks) {
    if (!record(block) || block.type !== "rich_text" || !Array.isArray(block.elements)) return false;
    for (const container of block.elements) {
      if (!record(container)) return false;
      if (container.type === "rich_text_list") {
        if (!["bullet", "ordered"].includes(String(container.style)) || !Array.isArray(container.elements)
          || (container.indent !== undefined && (!Number.isInteger(container.indent) || Number(container.indent) < 0))) return false;
        for (const section of container.elements) {
          if (!record(section) || section.type !== "rich_text_section") return false;
          const result = inlineElements(section.elements, target, true);
          if (!result.valid) return false;
          found ||= result.found;
        }
      } else {
        if (!["rich_text_section", "rich_text_quote", "rich_text_preformatted"].includes(String(container.type))) return false;
        const result = inlineElements(container.elements, target, container.type === "rich_text_section");
        if (!result.valid) return false;
        found ||= result.found;
      }
    }
  }
  return found;
}

function angleEnd(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "<") depth++;
    if (text[i] === ">" && --depth === 0) return i;
  }
  return text.length;
}

function textMention(text: string, target: string): boolean {
  let codeTicks = 0;
  for (const line of text.split("\n")) {
    // Slack's >>> quote consumes all subsequent lines. A single > quotes only
    // its own line. Whitespace is admitted conservatively as quoted text.
    if (!codeTicks && line.trimStart().startsWith(">>>")) return false;
    if (!codeTicks && line.trimStart().startsWith(">")) continue;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === "\\") {
        i = line[i + 1] === "<" ? angleEnd(line, i + 1) : i + 1;
        continue;
      }
      if (line[i] === "`") {
        let end = i + 1;
        while (line[end] === "`") end++;
        const ticks = end - i;
        if (!codeTicks) codeTicks = ticks;
        else if (ticks === codeTicks) codeTicks = 0;
        i = end - 1;
        continue;
      }
      if (line[i] === "<" && !codeTicks) {
        const end = angleEnd(line, i);
        // Consume the entire angle token so a link label is never reparsed as
        // a user mention. Display-name and escaped representations do not match.
        if (line.slice(i, end + 1) === `<@${target}>`) return true;
        i = end;
      }
    }
  }
  return false;
}

/** Only detects syntax; the caller must enforce sender, scope and authority. */
export function hasActiveSlackUserMention(
  event: { text: string; blocks?: unknown },
  targetUserId: string,
): boolean {
  if (!SlackUserIdSchema.safeParse(targetUserId).success || typeof event.text !== "string" || event.text.length > MAX_TEXT) return false;
  // A present but malformed/unsupported representation is not permission to
  // reinterpret fallback text, which may contain quoted or formatted mentions.
  return Object.hasOwn(event, "blocks")
    ? richTextMention(event.blocks, targetUserId)
    : textMention(event.text, targetUserId);
}
