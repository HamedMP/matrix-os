import type { CanonicalChatMessage } from "#canonical-chat";

const MAX_TEXT_UNITS = 32_000;
const MAX_TEXT_BYTES = 96 * 1024;
const MAX_PARTS = 64;
const MAX_MESSAGE_BYTES = 128 * 1024;
const encoder = new TextEncoder();
const blankUnit = /\s/u;
const unavailable = () => ({ type: "status" as const, tone: "info" as const,
  label: "This response cannot be displayed in this version of Matrix OS." });
type Parts = CanonicalChatMessage["parts"];

function coarseParts(parts: Parts, label?: string): Parts {
  let inserted = false;
  return parts.flatMap<Parts[number]>(part => {
    if (part.type !== "text") return [part];
    if (inserted) return [];
    inserted = true;
    return [{ ...unavailable(), ...(label ? { label } : {}) }];
  });
}

function boundary(text: string, index: number): boolean {
  if (index === 0 || index === text.length) return true;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

/** Find a minimum-part exact partition. A chunk must contain a nonblank unit;
 * its previous boundary must lie before the latest nonblank unit. A monotone
 * queue finds the cheapest eligible previous boundary in linear time. */
function legacyChunks(text: string): string[] | undefined {
  if (!text.trim() || text.length > MAX_PARTS * MAX_TEXT_UNITS) return undefined;
  if (text.length <= MAX_TEXT_UNITS) return [text];
  const costs = new Uint8Array(text.length + 1).fill(255);
  const previous = new Int32Array(text.length + 1);
  const candidates = new Int32Array(text.length + 1);
  costs[0] = 0;
  let latestNonblank = -1, added = 0, head = 0, tail = 0;
  for (let end = 1; end <= text.length; end++) {
    if (!blankUnit.test(text[end - 1]!)) latestNonblank = end - 1;
    while (added <= latestNonblank) {
      if (costs[added]! < MAX_PARTS) {
        while (tail > head && costs[candidates[tail - 1]!]! >= costs[added]!) tail--;
        candidates[tail++] = added;
      }
      added++;
    }
    while (head < tail && candidates[head]! < end - MAX_TEXT_UNITS) head++;
    if (head < tail && boundary(text, end)) {
      const start = candidates[head]!;
      costs[end] = costs[start]! + 1;
      previous[end] = start;
    }
  }
  if (costs[text.length]! > MAX_PARTS) return undefined;
  const chunks: string[] = [];
  for (let end = text.length; end > 0;) {
    const start = previous[end]!;
    const chunk = text.slice(start, end);
    if (encoder.encode(chunk).byteLength > MAX_TEXT_BYTES) return undefined;
    chunks.push(chunk);
    end = start;
  }
  return chunks.reverse();
}

function projectTextSpans(parts: Parts, compactCompatible: boolean): Parts {
  const projected: Parts = [];
  let changed = false;
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.type !== "text") { projected.push(part); index++; continue; }
    const texts: string[] = [];
    let compatible = true;
    while (index < parts.length && parts[index]!.type === "text") {
      const text = (parts[index++] as Extract<Parts[number], { type: "text" }>).text;
      texts.push(text);
      compatible &&= text.length <= MAX_TEXT_UNITS && text.trim().length > 0
        && encoder.encode(text).byteLength <= MAX_TEXT_BYTES;
    }
    if (compatible && !compactCompatible) projected.push(...texts.map(text => ({ type: "text" as const, text })));
    else {
      changed = true;
      const chunks = legacyChunks(texts.join(""));
      if (chunks) projected.push(...chunks.map(text => ({ type: "text" as const, text })));
      else projected.push(unavailable());
    }
  }
  return !changed ? parts : projected;
}

/** Preserve stable spans first; at most one extra pass minimizes every span. */
function legacyProjection(parts: Parts): { parts: Parts; compacted: boolean } {
  const projected = projectTextSpans(parts, false);
  if (projected === parts || projected.length <= MAX_PARTS) return { parts: projected, compacted: false };
  const compacted = projectTextSpans(parts, true);
  return { parts: compacted.length <= MAX_PARTS ? compacted : coarseParts(parts), compacted: true };
}

/** Display-only projection. Never write these parts into owner storage/outbox. */
export function projectLegacyAssistantTextParts(parts: Parts): Parts {
  return legacyProjection(parts).parts;
}

/** Preserve every identity/cursor field, including collaboration message fields.
 * An encoded-budget fallback must not turn into an unreadable oversized DTO.
 * Callers with another DTO budget can override the canonical message cap. */
export function projectLegacyAssistantMessage<T extends { role: string; parts: Parts }>(
  message: T, options: { maxEncodedBytes?: number } = {},
): T {
  if (message.role !== "assistant") return message;
  const maxEncodedBytes = options.maxEncodedBytes ?? MAX_MESSAGE_BYTES;
  const projection = legacyProjection(message.parts);
  const parts = projection.parts;
  if (parts === message.parts) return message;
  const projected = { ...message, parts };
  if (encoder.encode(JSON.stringify(projected)).byteLength <= maxEncodedBytes) return projected;
  if (!projection.compacted) {
    const compacted = { ...message, parts: projectTextSpans(message.parts, true) };
    if (compacted.parts.length <= MAX_PARTS && encoder.encode(JSON.stringify(compacted)).byteLength <= maxEncodedBytes) return compacted;
  }
  // Never drop an approval/tool/resource part to fit a legacy display notice.
  const coarse = { ...message, parts: coarseParts(message.parts, "Response unavailable in this version.") };
  if (encoder.encode(JSON.stringify(coarse)).byteLength <= maxEncodedBytes) return coarse;
  // At the exact message cap even a short notice may not fit. Omit only text;
  // preserve nontext semantics and every identity field, never the raw data.
  return { ...message, parts: message.parts.filter(part => part.type !== "text") };
}
