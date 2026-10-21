import { resolveChatMessageLink, type FileResourceRef } from "@matrix-os/contracts";

export type PreviewLink = { kind: "file"; path: string } | { kind: "web"; url: string };

/** Resolve a Markdown link within the preview's authorized resource scope. */
export function resolvePreviewLink(href: string, resource: FileResourceRef): PreviewLink | null {
  if (resource.kind === "artifact" || !href || href.startsWith("#") || href.startsWith("//")) return null;
  const direct = resolveChatMessageLink(href);
  if (direct?.kind === "web") return direct;
  if (/^(?:\/home\/matrix\/home\/|\/files\/|~\/|file:\/\/\/)/i.test(href)) return direct;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("/")) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(href.split(/[?#]/, 1)[0] ?? ""); }
  catch (error: unknown) { if (error instanceof URIError) return null; throw error; }
  const parts = resource.path.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const target = resolveChatMessageLink(parts.join("/"));
  return target?.kind === "file" ? target : null;
}
