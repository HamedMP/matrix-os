import { ChevronRight, CircleAlert, FileText } from "lucide-react";
import { useEffect, useState } from "react";
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
}: {
  message: ConversationMessagePresentation;
  callbacks: ConversationPresentationCallbacks;
  showMetadata: boolean;
}) {
  return (
    <ConversationItem messageId={`${message.role}:${message.id}`}>
      <Message>
        <MessageContent>
          <Bubble variant="ghost">
            <BubbleContent className="max-w-[620px] overflow-visible">
              <MessageResponse copyText={callbacks.copyText}>{message.markdown}</MessageResponse>
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
              className={`max-w-[620px] rounded-lg border px-3 py-2 text-sm ${failed ? "flex items-start gap-2" : ""}`}
              style={{
                borderColor: failed
                  ? "color-mix(in srgb, var(--danger) 35%, var(--border-subtle))"
                  : "var(--border-subtle)",
                color: failed ? "var(--danger)" : "var(--text-secondary)",
              }}
            >
              {failed ? <CircleAlert size={15} aria-hidden className="mt-0.5 shrink-0" /> : null}
              <MessageResponse copyText={callbacks.copyText}>{notice.markdown}</MessageResponse>
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
}: {
  item: ConversationWorkPresentation;
  callbacks: ConversationPresentationCallbacks;
  showMetadata?: boolean;
}) {
  if (item.kind === "activity-group") {
    return (
      <ConversationItem messageId={item.id}>
        <ConversationActivityGroup activities={item.activities} callbacks={callbacks} />
      </ConversationItem>
    );
  }
  if (item.kind === "notice") return <Notice notice={item} callbacks={callbacks} />;
  return <ResponseMessage message={item} callbacks={callbacks} showMetadata={showMetadata} />;
}

function ConversationTurn({
  turn,
  callbacks,
}: {
  turn: ConversationTurnPresentation;
  callbacks: ConversationPresentationCallbacks;
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
        <PresentationItem item={turn.final} callbacks={callbacks} showMetadata={!turn.active} />
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
  return (
    <Conversation>
      <ConversationContent className="justify-start pt-8 sm:pt-12">
        {turns.map((turn) => (
          <ConversationTurn key={turn.id} turn={turn} callbacks={callbacks} />
        ))}
      </ConversationContent>
    </Conversation>
  );
}
