import {
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  FileText,
  Link2,
  MessageCircle,
  ShieldAlert,
  Wrench,
} from "@renderer/lib/hugeicons";
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
  ConversationRequestPresentation,
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
    <ConversationItem messageId={`receipt:${startedAt}`} className="-mb-1">
      <Marker variant="border" className="min-h-10 pb-1">
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
  const lines = message.markdown.split("\n");
  const collapsible = message.markdown.length > 700 || lines.length > 12;
  const [expanded, setExpanded] = useState(false);
  const references = message.references ?? message.attachments ?? [];
  const visibleMarkdown = collapsible && !expanded
    ? `${lines.slice(0, 10).join("\n").slice(0, 700)}…`
    : message.markdown;
  const renderStructuredContent = Boolean(message.content?.length) && (!collapsible || expanded);
  return (
    <ConversationItem messageId={`user:${message.id}`} scrollAnchor>
      <Message align="end">
        <MessageContent className="gap-0">
          <Bubble variant="plain" align="end">
            <BubbleContent className="max-w-[48rem] whitespace-pre-wrap rounded-none px-0 py-px text-md leading-[16px]" data-selectable>
              {renderStructuredContent ? message.content!.map((segment, index) => {
                if (segment.kind === "text") return <span key={`text:${index}`}>{segment.text}</span>;
                if (segment.kind === "image") {
                  return (
                    <span key={`image:${segment.id}`} className="mt-2 block overflow-hidden rounded-lg border" style={{ borderColor: "var(--border-default)" }}>
                      <AuthenticatedMessageImage
                        src={segment.src}
                        label={segment.label}
                        loadImage={callbacks.loadImage}
                      />
                    </span>
                  );
                }
                const Icon = segment.referenceKind === "file"
                  ? FileText
                  : segment.referenceKind === "resource" ? Link2 : Wrench;
                return (
                  <span
                    key={`${segment.referenceKind}:${segment.id}`}
                    className="mx-0.5 inline-flex max-w-full translate-y-px items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs"
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

function AuthenticatedMessageImage({
  src,
  label,
  loadImage,
}: {
  src: string;
  label: string;
  loadImage?: (src: string) => Promise<Blob>;
}) {
  const [resolvedSrc, setResolvedSrc] = useState(loadImage ? "" : src);
  useEffect(() => {
    if (!loadImage) {
      setResolvedSrc(src);
      return;
    }
    let active = true;
    let objectUrl: string | undefined;
    void loadImage(src).then((blob) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setResolvedSrc(objectUrl);
    }).catch((error: unknown) => {
      console.warn("[conversation] image preview unavailable:", error instanceof Error ? error.name : "UnknownError");
    });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [loadImage, src]);
  return resolvedSrc ? (
    <img src={resolvedSrc} alt={label} className="block max-h-72 w-full object-contain" />
  ) : (
    <span role="status" aria-label={`Loading ${label}`} className="block px-3 py-6 text-center text-xs" style={{ color: "var(--text-tertiary)" }}>
      Loading image…
    </span>
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
    <ConversationItem messageId={`${message.role}:${message.id}`} className="mt-4">
      <Message>
        <MessageContent className="gap-0">
          <Bubble variant="ghost">
            <BubbleContent className="max-w-[64rem] overflow-visible">
              <MessageResponse className="text-md leading-[16px] [&_p]:my-0" copyText={callbacks.copyText} openFile={callbacks.openFile}>{visibleMarkdown}</MessageResponse>
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
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const availableActions = (notice.actions ?? []).filter((action) => (
    callbacks.performAction && (!callbacks.canPerformAction || callbacks.canPerformAction(action))
  ));
  const perform = async (action: typeof availableActions[number]) => {
    if (!callbacks.performAction || pendingAction) return;
    setPendingAction(action.kind);
    setActionFailed(false);
    try {
      await callbacks.performAction(action, undefined);
    } catch (error) {
      console.warn("[conversation] action failed:", error instanceof Error ? error.name : "UnknownError");
      setActionFailed(true);
    } finally {
      setPendingAction(null);
    }
  };
  return (
    <ConversationItem messageId={`notice:${notice.id}`}>
      <Message>
        <MessageContent>
          <div
              role="status"
              aria-label={notice.label}
              className={`w-fit min-w-[20rem] max-w-full rounded-xl border px-3 py-2.5 text-sm sm:max-w-[42rem] ${failed ? "flex items-start gap-2.5" : ""}`}
              style={{
                borderColor: failed ? "var(--danger)" : "var(--border-default)",
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
                  <MessageResponse copyText={callbacks.copyText} openFile={callbacks.openFile}>{notice.markdown}</MessageResponse>
                </div>
                {availableActions.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {availableActions.map((action) => (
                      <button
                        key={`${action.kind}:${action.label}`}
                        type="button"
                        aria-label={`${action.label} ${notice.label}`}
                        disabled={pendingAction !== null}
                        className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
                        style={{ borderColor: "var(--border-default)" }}
                        onClick={() => void perform(action)}
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                ) : null}
                {actionFailed ? <p role="alert" className="mt-1 text-xs">The action failed. Try again.</p> : null}
              </div>
          </div>
        </MessageContent>
      </Message>
    </ConversationItem>
  );
}

function Request({
  request,
  callbacks,
}: {
  request: ConversationRequestPresentation;
  callbacks: ConversationPresentationCallbacks;
}) {
  const [answer, setAnswer] = useState("");
  const [pending, setPending] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const activeAction = useRef<symbol | null>(null);
  const availableActions = (request.actions ?? []).filter((action) => (
    callbacks.performAction && (!callbacks.canPerformAction || callbacks.canPerformAction(action))
  ));
  const inputAction = availableActions.find((action) => action.kind === "input");
  const label = `${request.requestKind === "approval" ? "Approval" : "Input"} ${request.state === "waiting" ? "required" : "resolved"}: ${request.label}`;
  const perform = async (action: typeof availableActions[number], input?: string) => {
    if (!callbacks.performAction || activeAction.current) return;
    const actionToken = Symbol("conversation-request-action");
    activeAction.current = actionToken;
    setPending(true);
    setActionFailed(false);
    try {
      await callbacks.performAction(action, input);
    } catch (error) {
      console.warn("[conversation] request action failed:", error instanceof Error ? error.name : "UnknownError");
      setActionFailed(true);
    } finally {
      if (activeAction.current === actionToken) {
        activeAction.current = null;
        setPending(false);
      }
    }
  };
  const Icon = request.requestKind === "approval" ? ShieldAlert : MessageCircle;
  return (
    <ConversationItem messageId={`request:${request.id}`}>
      <div
        role="group"
        aria-label={label}
        className="max-w-[620px] rounded-xl border p-3"
        style={{ borderColor: "var(--border-default)", background: "var(--bg-sunken)" }}
      >
        <div className="flex min-w-0 items-start gap-2.5">
          {request.state === "resolved"
            ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: "var(--success)" }} />
            : <Icon aria-hidden className="mt-0.5 size-4 shrink-0" style={{ color: "var(--text-secondary)" }} />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium">{request.label}</p>
              {request.risk ? (
                <span className="rounded-full border px-1.5 py-0.5 text-[10px] uppercase tracking-wide" style={{ borderColor: "var(--border-default)", color: "var(--text-tertiary)" }}>
                  {request.risk} risk
                </span>
              ) : null}
            </div>
            {request.detail ? <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>{request.detail}</p> : null}
            {request.state === "waiting" && inputAction ? (
              <form
                className="mt-2 flex min-w-0 gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (answer.trim()) void perform(inputAction, answer.trim());
                }}
              >
                <input
                  aria-label={`Answer ${request.label}`}
                  value={answer}
                  disabled={pending}
                  className="h-8 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-sm outline-none focus:border-[var(--accent)]"
                  style={{ borderColor: "var(--border-default)" }}
                  onChange={(event) => setAnswer(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  disabled={pending || answer.trim().length === 0}
                  className="rounded-md bg-[var(--accent)] px-2.5 text-xs font-medium text-[var(--text-on-accent)] disabled:opacity-50"
                >
                  {inputAction.label}
                </button>
              </form>
            ) : null}
            {request.state === "waiting" && request.requestKind === "approval" && availableActions.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {availableActions.map((action) => (
                  <button
                    key={action.kind === "approval" ? action.decision : action.label}
                    type="button"
                    aria-label={`${action.label} ${request.label}`}
                    disabled={pending}
                    className="rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] disabled:opacity-50"
                    style={{ borderColor: "var(--border-default)" }}
                    onClick={() => void perform(action, undefined)}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
            {actionFailed ? <p role="alert" className="mt-1 text-xs">The action failed. Try again.</p> : null}
          </div>
        </div>
      </div>
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
  if (item.kind === "request") return <Request request={item} callbacks={callbacks} />;
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
  const terminalPartial = !turn.active
    && turn.final?.kind === "notice"
    && (turn.final.tone === "failed" || turn.final.tone === "stopped")
    ? [...turn.work].reverse().find((item) => item.kind === "message")
    : undefined;
  const visibleWork = showWork ? turn.work : terminalPartial ? [terminalPartial] : [];
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
      {visibleWork.length > 0 ? (
        <div data-work-items className="flex min-w-0 flex-col gap-0.5">
          {visibleWork.map((item) => (
            <PresentationItem key={item.id} item={item} callbacks={callbacks} />
          ))}
        </div>
      ) : null}
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
  const [initialFinalIds] = useState(() => new Set(
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
            initialFinalIds={initialFinalIds}
          />
        ))}
      </ConversationContent>
    </Conversation>
  );
}
