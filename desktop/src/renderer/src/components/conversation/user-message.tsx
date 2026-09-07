import { FileText, Link2, Wrench } from "@renderer/lib/hugeicons";
import { useState } from "react";
import { ChatAttachments, type ChatMessageAttachment } from "@matrix-os/ui";
import { ConversationItem } from "./conversation";
import { Bubble, BubbleContent } from "./bubble";
import { Message, MessageContent, MessageMetadata } from "./message";
import type { ConversationMessagePresentation, ConversationPresentationCallbacks } from "./presentation";

export function UserMessage({
  message,
  callbacks,
}: {
  message: ConversationMessagePresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const lines = message.markdown.split("\n");
  const collapsible = message.markdown.length > 700 || lines.length > 12;
  const [expanded, setExpanded] = useState(false);
  const references = (message.references ?? message.attachments ?? []).filter((reference) =>
    reference.kind !== "file" || !message.content?.some((segment) =>
      segment.kind !== "text" && segment.id === reference.id
      && (segment.kind === "image" || segment.referenceKind === "file")));
  const visibleMarkdown = collapsible && !expanded
    ? `${lines.slice(0, 10).join("\n").slice(0, 700)}…`
    : message.markdown;
  const renderStructuredContent = Boolean(message.content?.length) && (!collapsible || expanded);
  const hasBubbleContent = renderStructuredContent
    ? message.content!.some((segment) => segment.kind === "text"
      ? segment.text.trim().length > 0
      : segment.kind === "reference" && segment.referenceKind !== "file")
    : visibleMarkdown.trim().length > 0 || references.length > 0;
  return (
    <ConversationItem messageId={`user:${message.id}`} scrollAnchor>
      <Message align="end">
        <MessageContent className="gap-1.5">
          <ChatAttachments attachments={(message.content ?? []).flatMap<ChatMessageAttachment>((segment) => segment.kind === "image"
            ? [{ ...segment, kind: "image" as const }]
            : segment.kind === "reference" && segment.referenceKind === "file" ? [{ ...segment, kind: "file" as const }] : [])}
            open={callbacks.openAttachment} loadImage={callbacks.loadImage} />
          {hasBubbleContent ? <Bubble variant="secondary" align="end" className="max-w-[min(85%,48rem)]">
            <BubbleContent className="max-w-full whitespace-pre-wrap [overflow-wrap:anywhere] rounded-2xl px-4 py-3 text-[14px] leading-relaxed"
              style={{ background: "color-mix(in srgb, var(--text-primary) 7%, var(--bg-surface))", borderColor: "color-mix(in srgb, var(--text-primary) 6%, transparent)" }} data-selectable>
              {renderStructuredContent ? message.content!.map((segment, index) => {
                if (segment.kind === "text") return <span key={`text:${index}`}>{segment.text}</span>;
                if (segment.kind === "image" || segment.referenceKind === "file") return null;
                const Icon = segment.referenceKind === "resource" ? Link2 : Wrench;
                return (
                  <span
                    key={`${segment.referenceKind}:${segment.id}`}
                    className="my-2 inline-flex max-w-full items-center gap-2 rounded-xl border bg-[var(--bg-surface)] px-3 py-2 text-sm disabled:cursor-default hover:enabled:bg-[var(--bg-hover)]"
                    style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
                  >
                    <Icon size={12} aria-hidden className="shrink-0" />
                    <span className="truncate">{segment.label}</span>
                  </span>
                );
              }) : visibleMarkdown}
              {!renderStructuredContent && references.length > 0 ? (
                <span className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {references.map((reference) => {
                    const Icon = reference.kind === "file" ? FileText : reference.kind === "resource" ? Link2 : Wrench;
                    return (
                    <span
                      key={`${reference.kind}:${reference.id}`}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
                    >
                      <Icon size={12} aria-hidden className="shrink-0" />
                      <span className="truncate">{reference.label}</span>
                    </span>
                    );
                  })}
                </span>
              ) : null}
              {collapsible ? (
                <button
                  type="button"
                  aria-label={expanded ? "Show less" : "Show full message"}
                  aria-expanded={expanded}
                  className="mt-2 block rounded-md text-xs font-medium underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                  style={{ color: "var(--text-secondary)" }}
                  onClick={() => setExpanded((value) => !value)}
                >
                  {expanded ? "Show less" : "Show more"}
                </button>
              ) : null}
            </BubbleContent>
          </Bubble> : null}
          <MessageMetadata
            content={message.copyText}
            timestamp={message.timestamp}
            role="User"
            copyText={callbacks.copyText}
          />
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}
