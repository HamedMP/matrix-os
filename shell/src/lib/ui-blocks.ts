export interface UICardData {
  title: string;
  emoji?: string;
  description?: string;
}

export interface UIOptionData {
  label: string;
  value?: string;
}

export interface UIStatusData {
  level: "info" | "success" | "warning" | "error";
  message: string;
}

export type ContentSegment =
  | { type: "markdown"; content: string }
  | { type: "ui:cards"; data: UICardData[] }
  | { type: "ui:options"; data: UIOptionData[] }
  | { type: "ui:status"; data: UIStatusData };

const UI_BLOCK_RE = /```ui:(cards|options|status)\n([\s\S]*?)```/g;

export function parseContentSegments(markdown: string): ContentSegment[] {
  if (!markdown) return [];

  const segments: ContentSegment[] = [];
  let lastIndex = 0;

  for (const match of markdown.matchAll(UI_BLOCK_RE)) {
    const beforeText = markdown.slice(lastIndex, match.index);
    if (beforeText.trim()) {
      segments.push({ type: "markdown", content: beforeText });
    }

    const blockType = match[1] as "cards" | "options" | "status";
    const rawJson = match[2].trim();

    try {
      const parsed = JSON.parse(rawJson);

      if (blockType === "cards" && Array.isArray(parsed)) {
        segments.push({ type: "ui:cards", data: parsed });
      } else if (blockType === "options" && Array.isArray(parsed)) {
        segments.push({ type: "ui:options", data: parsed });
      } else if (blockType === "status" && parsed && typeof parsed === "object") {
        segments.push({ type: "ui:status", data: parsed });
      } else {
        segments.push({ type: "markdown", content: match[0] });
      }
    } catch {
      segments.push({ type: "markdown", content: match[0] });
    }

    lastIndex = match.index! + match[0].length;
  }

  const trailing = markdown.slice(lastIndex);
  if (trailing.trim()) {
    segments.push({ type: "markdown", content: trailing });
  }

  return segments;
}
