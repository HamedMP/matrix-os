"use client";

import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();
const FILES_PREFIX = "/files/";
const SAFE_SAME_ORIGIN_SVG_PREFIXES = ["/apps/", "/icons/"] as const;

interface MarkdownViewerProps {
  content: string;
  sourcePath?: string;
}

type MarkdownImageProps = ComponentPropsWithoutRef<"img"> & {
  node?: unknown;
};

type MarkdownSvgPreviewProps = Omit<ComponentPropsWithoutRef<"img">, "src"> & {
  sourcePath?: string;
  src?: string;
};

type SvgSourceResolution =
  | { ok: true; src: string }
  | { ok: false };

const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (key === "src" && node.tagName === "img" && isSvgReference(url)) {
    return url;
  }
  return defaultUrlTransform(url);
};

export function MarkdownViewer({ content, sourcePath }: MarkdownViewerProps) {
  return (
    <div className="md-prose max-w-none p-4 overflow-auto h-full">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        urlTransform={markdownUrlTransform}
        components={{
          img: ({ node: _node, src, alt, title, ...props }: MarkdownImageProps) => {
            const imageSrc = typeof src === "string" ? src : undefined;

            if (isSvgReference(imageSrc)) {
              return (
                <MarkdownSvgPreview
                  {...props}
                  alt={alt}
                  sourcePath={sourcePath}
                  src={imageSrc}
                  title={title}
                />
              );
            }

            // react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- markdown can reference arbitrary user and gateway assets; next/image cannot optimize dynamic Markdown URLs
            return <img {...props} alt={alt ?? ""} src={src} title={title} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownSvgPreview({
  alt,
  sourcePath,
  src,
  title,
  ...props
}: MarkdownSvgPreviewProps) {
  const resolved = useMemo(
    () => resolveSvgPreviewSource(src, sourcePath),
    [src, sourcePath],
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [resolved.ok ? resolved.src : src]);

  if (!resolved.ok || failed) {
    return <SvgPreviewFallback alt={alt} />;
  }

  return (
    <span className="matrix-markdown-svg-preview">
      {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element -- SVG is intentionally rendered as an image document, never inline SVG markup */}
      <img
        {...props}
        alt={alt ?? ""}
        decoding="async"
        draggable={false}
        loading="lazy"
        onError={() => setFailed(true)}
        referrerPolicy="no-referrer"
        src={resolved.src}
        title={title}
      />
    </span>
  );
}

function SvgPreviewFallback({ alt }: { alt?: string }) {
  return (
    <span
      aria-label="SVG preview unavailable"
      className="matrix-markdown-svg-fallback"
      role="note"
    >
      <span className="matrix-markdown-svg-fallback-title">
        SVG preview unavailable
      </span>
      {alt ? (
        <span className="matrix-markdown-svg-fallback-alt">{alt}</span>
      ) : null}
    </span>
  );
}

function resolveSvgPreviewSource(
  rawSrc: string | undefined,
  sourcePath: string | undefined,
): SvgSourceResolution {
  const value = rawSrc?.trim();
  if (!value || !isSvgReference(value) || containsControlCharacter(value)) {
    return { ok: false };
  }

  if (value.startsWith("//")) {
    return { ok: false };
  }

  if (hasExplicitScheme(value)) {
    return resolveRemoteSvgSource(value);
  }

  const { path, suffix } = splitAssetReference(value);
  if (path.startsWith(FILES_PREFIX)) {
    const localPath = normalizeFilePath(path.slice(FILES_PREFIX.length));
    if (!localPath) return { ok: false };
    return { ok: true, src: `${GATEWAY_URL}${FILES_PREFIX}${encodeFilePath(localPath)}${suffix}` };
  }

  if (SAFE_SAME_ORIGIN_SVG_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    const normalized = normalizeRootedPath(path);
    if (!normalized) return { ok: false };
    return { ok: true, src: `${GATEWAY_URL}${normalized}${suffix}` };
  }

  const localPath = normalizeMarkdownLocalPath(path, sourcePath);
  if (!localPath) return { ok: false };
  return { ok: true, src: `${GATEWAY_URL}${FILES_PREFIX}${encodeFilePath(localPath)}${suffix}` };
}

function resolveRemoteSvgSource(value: string): SvgSourceResolution {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { ok: false };
    }
    if (!url.pathname.toLowerCase().endsWith(".svg")) {
      return { ok: false };
    }
    return { ok: true, src: url.href };
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return { ok: false };
    }
    throw error;
  }
}

function isSvgReference(rawSrc: string | undefined): boolean {
  const value = rawSrc?.trim();
  if (!value) return false;
  if (/^data:image\/svg\+xml(?:[;,]|$)/i.test(value)) return true;

  const { path } = splitAssetReference(value);
  if (hasExplicitScheme(path)) {
    try {
      return new URL(value).pathname.toLowerCase().endsWith(".svg");
    } catch (error: unknown) {
      if (error instanceof TypeError) return false;
      throw error;
    }
  }

  return path.toLowerCase().endsWith(".svg");
}

function normalizeMarkdownLocalPath(
  rawPath: string,
  sourcePath: string | undefined,
): string | null {
  const path = rawPath.startsWith("/") ? rawPath.slice(1) : rawPath;
  if (rawPath.startsWith("/")) {
    return normalizeFilePath(path);
  }

  const sourceDir = sourcePath ? dirname(sourcePath) : "";
  return normalizeFilePath(sourceDir ? `${sourceDir}/${path}` : path);
}

function normalizeRootedPath(rawPath: string): string | null {
  if (!rawPath.startsWith("/")) return null;
  const normalized = normalizeFilePath(rawPath.slice(1));
  return normalized ? `/${encodeFilePath(normalized)}` : null;
}

function normalizeFilePath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\\") || containsControlCharacter(rawPath)) {
    return null;
  }

  const segments: string[] = [];
  for (const segment of rawPath.split("/")) {
    if (!segment || segment === ".") continue;
    const decoded = decodePathSegment(segment);
    if (decoded === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    if (decoded.includes("/") || decoded.includes("\\") || containsControlCharacter(decoded)) {
      return null;
    }
    segments.push(decoded);
  }

  return segments.length > 0 ? segments.join("/") : null;
}

function encodeFilePath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error: unknown) {
    if (error instanceof URIError) return segment;
    throw error;
  }
}

function dirname(path: string): string {
  const normalized = normalizeFilePath(path);
  if (!normalized) return "";
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function splitAssetReference(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const splitIndex = [queryIndex, hashIndex]
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0];

  if (splitIndex === undefined) {
    return { path: value, suffix: "" };
  }

  return {
    path: value.slice(0, splitIndex),
    suffix: value.slice(splitIndex),
  };
}

function hasExplicitScheme(value: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(value);
}

function containsControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}
