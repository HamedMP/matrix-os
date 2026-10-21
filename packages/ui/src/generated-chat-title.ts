// Automatic titles only: persisted and manually renamed titles remain owner-controlled.
const MAX_GENERATED_TITLE_LENGTH = 56;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function boundGeneratedTitle(title: string): string {
  if (title.length <= MAX_GENERATED_TITLE_LENGTH) return title;
  let prefix = "";
  for (const { segment } of graphemes.segment(title)) {
    if (prefix.length + segment.length >= MAX_GENERATED_TITLE_LENGTH) break;
    prefix += segment;
  }
  return `${prefix.replace(/\s+\S*$/, "").trimEnd()}…`;
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

/** Strip simple link destinations in one pass, including IPv6 brackets. */
function markdownLinkText(text: string): string {
  let output = "";
  let copiedUntil = 0;
  let labelStart = -1;
  let escaped = false;
  let link: { start: number; labelEnd: number; destinationStart: number } | null = null;
  for (let index = 0; index < text.length; index++) {
    const character = text.charAt(index);
    const isEscaped = escaped;
    escaped = character === "\\" && !escaped;
    if (link && (character === ")" || /\s/.test(character))) {
      if (character === ")" && index > link.destinationStart) {
        output += text.slice(copiedUntil, link.start) + text.slice(link.start + 1, link.labelEnd);
        copiedUntil = index + 1;
        link = null;
        labelStart = -1;
        continue;
      }
      link = null;
    }
    // Keep the latest label candidate while scanning a destination: if that
    // destination fails at whitespace, a nested label may still form a link.
    if (character === "[" && !isEscaped) labelStart = index;
    else if (character === "]") {
      if (labelStart !== -1 && index > labelStart + 1 && text[index + 1] === "(") {
        link ??= { start: labelStart, labelEnd: index, destinationStart: index + 2 };
        index++;
      }
      labelStart = -1;
    }
  }
  return output + text.slice(copiedUntil);
}

export function generatedChatTitle(text: string, fallback?: string): string {
  const visiblePrompt = markdownLinkText(text)
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
