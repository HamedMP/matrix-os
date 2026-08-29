import { ChevronRight, CircleAlert, FileText } from "@renderer/lib/hugeicons";
import { useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationItem,
} from "./conversation";
import { ConversationActivityGroup } from "./activity";
import { Bubble, BubbleContent } from "./bubble";
import { Marker, MarkerContent } from "./marker";
import { Message, MessageContent, MessageMetadata, MessageResponse } from "./message";
import type {
  ConversationMessagePresentation,
  ConversationNoticePresentation,
  ConversationPresentationCallbacks,
  ConversationTurnPresentation,
  ConversationWorkPresentation,
} from "./presentation";

function formatTurnDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${totalSeconds}s`;
}

function TurnReceipt({
  startedAt,
  endedAt,
  active,
  expanded,
  canToggle,
  onToggle,
}: {
  startedAt: number;
  endedAt: number;
  active: boolean;
  expanded: boolean;
  canToggle: boolean;
  onToggle: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [active]);

  const elapsed = active ? now - startedAt : endedAt - startedAt;
  const label = `${active ? "Working" : "Worked"} for ${formatTurnDuration(elapsed)}`;
  return (
    <ConversationItem messageId={`receipt:${startedAt}`}>
      <Marker variant="border" className="min-h-10 pb-2">
        {canToggle ? (
          <button
            type="button"
            aria-label={label}
            aria-expanded={expanded}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-md py-1 pr-1 font-medium hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            onClick={onToggle}
          >
            <MarkerContent>{label}</MarkerContent>
            <ChevronRight
              size={15}
              aria-hidden
              className={`shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        ) : (
          <MarkerContent className="font-medium">{label}</MarkerContent>
        )}
      </Marker>
    </ConversationItem>
  );
}

function UserMessage({
  message,
  callbacks,
}: {
  message: ConversationMessagePresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  return (
    <ConversationItem messageId={`user:${message.id}`} scrollAnchor>
      <Message align="end">
        <MessageContent>
          <Bubble variant="secondary" align="end">
            <BubbleContent className="max-w-[580px] whitespace-pre-wrap" data-selectable>
              {message.markdown}
              {message.attachments?.length ? (
                <span className="mt-2 flex flex-wrap justify-end gap-1.5">
                  {message.attachments.map((attachment) => (
                    <span
                      key={attachment.id}
                      className="inline-flex max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                      style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
                    >
                      <FileText size={12} aria-hidden className="shrink-0" />
                      <span className="truncate">{attachment.label}</span>
                    </span>
                  ))}
                </span>
              ) : null}
            </BubbleContent>
          </Bubble>
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

function ResponseMessage({
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
  }, [message.markdown, visibleMarkdown]);

  return (
    <ConversationItem messageId={`${message.role}:${message.id}`}>
      <Message>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent className="max-w-[620px] overflow-visible">
              <MessageResponse copyText={callbacks.copyText}>{visibleMarkdown}</MessageResponse>
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

function Notice({
  notice,
  callbacks,
}: {
  notice: ConversationNoticePresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const failed = notice.tone === "failed";
  return (
    <ConversationItem messageId={`notice:${notice.id}`}>
      <Message>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent
              {...(failed ? { role: "status", "aria-label": notice.label } : {})}
              className={`max-w-[620px] rounded-xl px-3.5 py-3 text-sm ${failed ? "flex items-start gap-2.5" : ""}`}
              style={{
                background: failed
                  ? "color-mix(in srgb, var(--danger) 8%, transparent)"
                  : "var(--bg-sunken)",
                color: "var(--text-primary)",
              }}
            >
              {failed ? (
                <CircleAlert
                  size={16}
                  aria-hidden
                  className="mt-0.5 shrink-0"
                  style={{ color: "var(--danger)" }}
                />
              ) : null}
              <div className="min-w-0">
                <p className="font-medium leading-5">{notice.label}</p>
                <div className="mt-0.5 leading-5" style={{ color: "var(--text-secondary)" }}>
                  <MessageResponse copyText={callbacks.copyText}>{notice.markdown}</MessageResponse>
                </div>
              </div>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}

function PresentationItem({
  item,
  callbacks,
  showMetadata = false,
  streaming = false,
  animateOnMount = false,
}: {
  item: ConversationWorkPresentation;
  callbacks: ConversationPresentationCallbacks;
  showMetadata?: boolean;
  streaming?: boolean;
  animateOnMount?: boolean;
}) {
  if (item.kind === "activity-group") {
    return (
      <ConversationItem messageId={item.id}>
        <ConversationActivityGroup activities={item.activities} callbacks={callbacks} />
      </ConversationItem>
    );
  }
  if (item.kind === "notice") return <Notice notice={item} callbacks={callbacks} />;
  return (
    <ResponseMessage
      message={item}
      callbacks={callbacks}
      showMetadata={showMetadata}
      streaming={streaming}
      animateOnMount={animateOnMount}
    />
  );
}

function ConversationTurn({
  turn,
  callbacks,
  initialFinalIds,
}: {
  turn: ConversationTurnPresentation;
  callbacks: ConversationPresentationCallbacks;
  initialFinalIds: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const showWork = turn.active || expanded;
  const hasWork = turn.work.length > 0;
  return (
    <>
      {turn.user ? <UserMessage message={turn.user} callbacks={callbacks} /> : null}
      {hasWork || turn.final || turn.active ? (
        <TurnReceipt
          startedAt={turn.startedAt}
          endedAt={turn.endedAt}
          active={turn.active}
          expanded={showWork}
          canToggle={!turn.active && hasWork}
          onToggle={() => setExpanded((value) => !value)}
        />
      ) : null}
      {showWork ? turn.work.map((item) => (
        <PresentationItem key={item.id} item={item} callbacks={callbacks} />
      )) : null}
      {turn.final ? (
        <PresentationItem
          item={turn.final}
          callbacks={callbacks}
          showMetadata={!turn.active}
          streaming={turn.active}
          animateOnMount={!initialFinalIds.has(turn.final.id)}
        />
      ) : null}
    </>
  );
}

export function ConversationTranscript({
  turns,
  callbacks,
}: {
  turns: ConversationTurnPresentation[];
  callbacks: ConversationPresentationCallbacks;
}) {
  const initialFinalIds = useRef(new Set(
    turns.flatMap((turn) => turn.final ? [turn.final.id] : []),
  ));
  return (
    <Conversation>
      <ConversationContent className="justify-start pt-8 sm:pt-12">
        {turns.map((turn) => (
          <ConversationTurn
            key={turn.id}
            turn={turn}
            callbacks={callbacks}
            initialFinalIds={initialFinalIds.current}
          />
        ))}
      </ConversationContent>
    </Conversation>
  );
}
