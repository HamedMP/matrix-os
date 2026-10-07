import { request as httpsRequest } from "node:https";
import { lookup } from "node:dns/promises";
import { createPinnedCustomMcpLookup } from "../custom-mcp/pinned-lookup.js";
import { validateCustomMcpUrl, type CustomMcpResolver, type ResolvedCustomMcpUrl } from "../custom-mcp/security.js";
import { IntegrationRefreshError } from "./contracts.js";

const MAX_BYTES = 512 * 1024;
const MAX_METADATA_CANDIDATE = 8192;
const MAX_TAG_BYTES = 4096;
const DEADLINE_MS = 10000;
interface PreviewResponse { status: number; contentType: string; body: string }
type PreviewTransport = (target: ResolvedCustomMcpUrl) => Promise<PreviewResponse>;

async function pinnedPreviewRequest(target: ResolvedCustomMcpUrl): Promise<PreviewResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(target.url, { method: "GET", lookup: createPinnedCustomMcpLookup(target), servername: target.url.hostname,
      signal: AbortSignal.timeout(DEADLINE_MS), headers: { accept: "text/html,text/plain", "accept-encoding": "identity" } }, response => {
      const status = response.statusCode ?? 502;
      if (status !== 200) { response.destroy(); reject(new IntegrationRefreshError("unavailable")); return; }
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) { response.destroy(new IntegrationRefreshError("budget")); return; }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({ status, contentType: String(response.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end();
  });
}
function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new IntegrationRefreshError("unavailable")), DEADLINE_MS); })])
    .finally(() => clearTimeout(timer!));
}
const defaultResolver: CustomMcpResolver = async hostname => (await lookup(hostname, { all: true, verbatim: true }))
  .filter((value): value is { address: string; family: 4 | 6 } => value.family === 4 || value.family === 6);
/** A single forward scan; quoted attribute text cannot close or start a tag. */
function tagBoundary(value: string, start: number): { start: number; end: number } | null {
  if (value.startsWith("<!--", start)) {
    const end = value.indexOf("-->", start + 4);
    return end < 0 ? null : { start, end: end + 2 };
  }
  let tagStart = start;
  let quote: string | null = null;
  for (let index = start + 1; index < value.length; index++) {
    const character = value[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "<") tagStart = index;
    else if (character === ">") return { start: tagStart, end: index };
  }
  return null;
}
/** Monotonic scans never retry an unmatched opener at every subsequent '<'. */
function stripMarkup(value: string): string {
  let cursor = 0;
  const text: string[] = [];
  while (cursor < value.length) {
    const start = value.indexOf("<", cursor);
    if (start < 0) { text.push(value.slice(cursor)); break; }
    text.push(value.slice(cursor, start));
    const boundary = tagBoundary(value, start);
    if (!boundary) { text.push(value.slice(start)); break; }
    text.push(" "); cursor = boundary.end + 1;
  }
  return text.join("");
}
function plain(value: string, limit: number, html = true): string {
  // Decode/normalize only a bounded metadata prefix, never the full response.
  const decoded = value.slice(0, MAX_METADATA_CANDIDATE).replace(/&(?:amp|lt|gt|quot|apos|#(?:\d+|x[0-9a-f]+));/gi, entity => {
    const named: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const point = entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
    return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
  });
  return (html ? stripMarkup(decoded) : decoded).replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}
function metadata(html: string, fallbackTitle: string): { title: string; description: string } {
  let cursor = 0; let titleStart: number | null = null;
  let title: string | null = null; let description = "";
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor);
    if (start < 0) break;
    const boundary = tagBoundary(html, start);
    if (!boundary) break;
    const { start: tagStart, end } = boundary;
    // Recover a closing tag after a run of unmatched '<' without repeated scans.
    cursor = end + 1;
    const tag = html.slice(tagStart, Math.min(end + 1, tagStart + MAX_TAG_BYTES + 1));
    const rawText = /^<(script|style)(?=[\s/>])/i.exec(tag)?.[1]?.toLowerCase();
    if (rawText) {
      // HTML treats these contents as raw text, even when they contain tag-like
      // strings. Search only for the matching end tag, with no repeated scans.
      const closing = rawText === "script" ? /<\/script(?=[\s/>])/gi : /<\/style(?=[\s/>])/gi;
      closing.lastIndex = cursor;
      const match = closing.exec(html);
      const close = match ? tagBoundary(html, match.index) : null;
      if (!close) break;
      cursor = close.end + 1;
      continue;
    }
    if (end - tagStart > MAX_TAG_BYTES) continue;
    if (title === null && /^<title\b/i.test(tag) && titleStart === null) titleStart = end + 1;
    else if (title === null && titleStart !== null && /^<\/title\s*>$/i.test(tag)) {
      title = plain(html.slice(titleStart, Math.min(tagStart, titleStart + MAX_METADATA_CANDIDATE)), 200);
    }
    if (!description && /^<meta\b/i.test(tag) && /(?:name|property)\s*=\s*(["'])(?:description|og:description)\1/i.test(tag)) {
      const value = /\bcontent\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag)?.[2];
      if (value) description = plain(value, 500);
    }
    if (title !== null && description) break;
  }
  return { title: title ?? plain(fallbackTitle, 200), description };
}

/** Untrusted metadata only; no image retrieval, scripts, redirects, cookies, or private hosts. */
export function createSafeDataUrlPreview(options: { resolver?: CustomMcpResolver; transport?: PreviewTransport } = {}) {
  const resolver: CustomMcpResolver = hostname => bounded((options.resolver ?? defaultResolver)(hostname));
  return async (rawUrl: string): Promise<{ url: string; title: string; description: string }> => {
    if (rawUrl.length > 2048) throw new IntegrationRefreshError("invalid");
    const target = await validateCustomMcpUrl(rawUrl, resolver);
    if (target.url.port && target.url.port !== "443") throw new IntegrationRefreshError("invalid");
    const response = await bounded((options.transport ?? pinnedPreviewRequest)(target));
    if (response.status !== 200 || Buffer.byteLength(response.body, "utf8") > MAX_BYTES || !/^text\/(html|plain)(?:;|$)/i.test(response.contentType)) throw new IntegrationRefreshError("unavailable");
    if (/^text\/plain/i.test(response.contentType)) return { url: target.url.href, title: target.url.hostname, description: plain(response.body, 500, false) };
    return { url: target.url.href, ...metadata(response.body, target.url.hostname) };
  };
}
