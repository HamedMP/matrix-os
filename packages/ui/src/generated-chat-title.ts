// Automatic titles only: persisted and manually renamed titles remain owner-controlled.
const MAX_GENERATED_TITLE_LENGTH = 56;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Paths read by their last part ("src/chat/retire.ts" is "retire.ts"); web links stay whole. */
function lastPathParts(title: string): string {
  return title.replace(/(?<=^|\s)(?![^\s]*:\/\/)\S*\/(?=\S)/g, "");
}

function boundGeneratedTitle(title: string): string {
  if (title.length <= MAX_GENERATED_TITLE_LENGTH) return title;
  const shorter = lastPathParts(title);
  if (shorter.length <= MAX_GENERATED_TITLE_LENGTH) return shorter;
  let prefix = "";
  for (const { segment } of graphemes.segment(shorter)) {
    if (prefix.length + segment.length >= MAX_GENERATED_TITLE_LENGTH) break;
    prefix += segment;
  }
  const words = prefix.replace(/\s+\S*$/, "").trimEnd();
  // Dropping a long cut word (a path, a long name) would leave almost nothing, so its cut start stays.
  return `${words.length >= MAX_GENERATED_TITLE_LENGTH / 2 ? words : prefix.trimEnd()}\u2026`;
}

function structuredPromptTitle(prompt: string): string | null {
  const markerMatches = prompt.matchAll(/\b[A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]*)+\b/g);
  for (const match of markerMatches) {
    const marker = match[0];
    const markerWords = marker.split(/[_-]+/).filter(Boolean);
    const looksLikeMarker = /\d/.test(marker)
      || markerWords.some((word) => word.length > 1 && word === word.toUpperCase());
    if (!looksLikeMarker) continue;

    const prefix = prompt.slice(0, match.index);
    const objectNouns = Array.from(prefix.matchAll(/\b(lines?|steps?|items?|bullets?|rows?|entries|examples?|commands?|tests?|messages?|responses?|results?|files?)\b/gi));
    const objectNoun = objectNouns.at(-1)?.[0]?.toLocaleLowerCase();
    if (!objectNoun) continue;

    const topic = [...markerWords, objectNoun].join(" ");
    return `${topic[0]?.toLocaleUpperCase()}${topic.slice(1)}`;
  }
  return null;
}

export function generatedChatTitle(text: string, fallback?: string): string {
  const visiblePrompt = text
    .replace(/\[([^\]]+)\]\([^\s)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:\/[a-z][a-z0-9_-]*\s+)+/i, "")
    .replace(/^(?:please\s+|can you\s+|could you\s+|would you\s+|help me\s+(?:to\s+)?|i (?:want|need) you to\s+|let['’]?s\s+)/i, "")
    .replace(/^(?:请(?:帮我)?|帮我|麻烦(?:你)?|能不能|可以)\s*/u, "")
    .split(/[!?。！？]|\.(?:\s|$)/u, 1)[0]
    ?.trim();
  const structuredTitle = visiblePrompt ? structuredPromptTitle(visiblePrompt) : null;
  const source = structuredTitle || visiblePrompt || fallback?.replace(/\s+/g, " ").trim() || "New chat";
  const titled = /^[a-z]/.test(source) ? `${source[0]?.toLocaleUpperCase()}${source.slice(1)}` : source;
  return boundGeneratedTitle(titled);
}
