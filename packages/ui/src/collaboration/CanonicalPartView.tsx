import React from "react";
import type { CanonicalChatMessagePart } from "@matrix-os/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
export function CanonicalPartView({ part, human = false }: { part: CanonicalChatMessagePart; human?: boolean }) {
  if (part.type === "text" || part.type === "summary") {
    return human ? <p className="whitespace-pre-wrap">{part.text}</p>
      : <div className="max-w-none text-sm leading-6"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={safeMarkdownUrl}
        components={{
          h1: ({ children }) => <h1 className="mb-2 mt-4 text-xl font-semibold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0">{children}</h3>,
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          code: ({ children }) => <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{children}</code>,
        }}>{part.text}</ReactMarkdown></div>;
  }
  if (part.type === "tool_request") return <MessageDetail label={part.label} detail={part.inputPreview} />;
  if (part.type === "tool_result") return <MessageDetail label={`Tool ${part.outcome}`} detail={part.text} />;
  if (part.type === "attachment_reference") return <MessageDetail label={part.label} detail={part.kind} />;
  if (part.type === "approval_request") return <MessageDetail label={part.title} detail={`${part.description} · ${part.risk} risk`} />;
  if (part.type === "approval_result") return <MessageDetail label="Approval updated" detail={part.decision.replaceAll("_", " ")} />;
  if (part.type === "status") return <MessageDetail label={part.label} detail={part.detail} tone={part.tone} />;
  if (part.type === "invocation_reference") return <MessageDetail label={part.invocation.invocation} detail={part.invocation.arguments} />;
  if (part.type === "resource_reference") return <MessageDetail label={part.resource.label} detail={part.resource.path ?? part.resource.kind} />;
  if (part.type === "import_reference") return <MessageDetail label={part.label} detail="Full content is available in the owner's private Chat." />;
  // Provenance is source metadata, never a participant message.
  return null;
}

export function keyedCanonicalParts(messageId: string, parts: CanonicalChatMessagePart[]) {
  const occurrences = new Map<string, number>(); // Per-message, bounded by the canonical 64-part schema.
  return parts.map((part) => {
    const valueKey = JSON.stringify(part);
    const occurrence = occurrences.get(valueKey) ?? 0;
    occurrences.set(valueKey, occurrence + 1);
    return { key: `${messageId}:${valueKey}:${occurrence}`, part };
  });
}

function MessageDetail({ label, detail, tone }: { label: string; detail?: string; tone?: string }) {
  return <div className="rounded-xl border px-3 py-2 text-sm" data-tone={tone}>
    <p className="font-medium">{label}</p>
    {detail ? <p className="mt-0.5 whitespace-pre-wrap text-xs text-muted-foreground">{detail}</p> : null}
  </div>;
}

function safeMarkdownUrl(value: string): string {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? value : "";
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) console.warn("[chat-collaboration] link validation failed", "UnknownError");
    return "";
  }
}

