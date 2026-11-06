import { useEffect, useRef, useState } from "react";
import { ChatAttachments, type ChatMessageAttachment } from "@matrix-os/ui";
import { ConversationItem } from "./conversation";
import { Bubble, BubbleContent } from "./bubble";
import { Message, MessageContent, MessageMetadata, MessageResponse } from "./message";
import type { ConversationMessagePresentation, ConversationPresentationCallbacks } from "./presentation";

export function ResponseMessage({
  message,
  callbacks,
  showMetadata,
  streaming,
  animateOnMount,
}: {
  message: ConversationMessagePresentation;
  callbacks: ConversationPresentationCallbacks;
  showMetadata: boolean;
  streaming: boolean;
  animateOnMount: boolean;
}) {
  const previousMessageId = useRef(message.id);
  const previousStreaming = useRef(streaming);
  const [visibleMarkdown, setVisibleMarkdown] = useState(() => (
    streaming || animateOnMount ? "" : message.markdown
  ));
  const attachments = (message.content ?? []).flatMap<ChatMessageAttachment>((segment) => segment.kind === "image"
    ? [{ ...segment, kind: "image" as const }]
    : segment.kind === "reference" && segment.referenceKind === "file"
      ? [{ ...segment, kind: "file" as const }]
      : []);

  useEffect(() => {
    if (previousMessageId.current === message.id) return;
    previousMessageId.current = message.id;
    setVisibleMarkdown(streaming || animateOnMount ? "" : message.markdown);
  }, [animateOnMount, message.id, message.markdown, streaming]);

  useEffect(() => {
    const terminalized = previousStreaming.current && !streaming;
    previousStreaming.current = streaming;
    if (terminalized) setVisibleMarkdown(message.markdown);
  }, [message.markdown, streaming]);

  useEffect(() => {
    if (visibleMarkdown === message.markdown) return;
    // Persisted commentary is already authoritative. Rendering it must not
    // depend on a typing animation, especially in an occluded Electron window.
    if ((!streaming && !animateOnMount) || document.hidden) {
      setVisibleMarkdown(message.markdown);
      return;
    }
    if (!message.markdown.startsWith(visibleMarkdown)) {
      setVisibleMarkdown(message.markdown);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setVisibleMarkdown((current) => {
        if (!message.markdown.startsWith(current)) return message.markdown;
        const targetCharacters = Array.from(message.markdown);
        const currentLength = Array.from(current).length;
        const remaining = targetCharacters.length - currentLength;
        const step = Math.max(1, Math.min(8, Math.ceil(remaining / 12)));
        return targetCharacters.slice(0, currentLength + step).join("");
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [animateOnMount, message.markdown, streaming, visibleMarkdown]);

  useEffect(() => {
    const revealWhenHidden = () => {
      if (document.hidden) setVisibleMarkdown(message.markdown);
    };
    document.addEventListener("visibilitychange", revealWhenHidden);
    return () => document.removeEventListener("visibilitychange", revealWhenHidden);
  }, [message.markdown]);

  return (
    <ConversationItem messageId={`${message.role}:${message.id}`}>
      <Message>
        <MessageContent className="gap-0">
          {attachments.length > 0 ? (
            <ChatAttachments
              attachments={attachments}
              align="start"
              open={callbacks.openAttachment} openImportedAsset={callbacks.openImportedAsset}
              loadImage={callbacks.loadImage}
            />
          ) : null}
          <Bubble variant="ghost">
            <BubbleContent className="w-full max-w-full overflow-visible">
              <MessageResponse className="text-md leading-relaxed" copyText={callbacks.copyText} openFile={callbacks.openFile} openWebLink={callbacks.openWebLink} loadFileImage={callbacks.loadFileImage} resolveApp={callbacks.resolveApp} openApp={callbacks.openApp}
                renderCredentialMarker={callbacks.renderCredentialMarker ? (offset, marker, number) => callbacks.renderCredentialMarker?.(message, offset, marker, number) : undefined}>{visibleMarkdown}</MessageResponse>
            </BubbleContent>
          </Bubble>
          {showMetadata ? (
            <MessageMetadata
              content={message.copyText}
              timestamp={message.timestamp}
              role="Assistant"
              copyText={callbacks.copyText}
            />
          ) : null}
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}
