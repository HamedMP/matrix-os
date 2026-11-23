import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Avatar, Checkbox, EmptyState, KeyHint, TextField } from "../../../../_shared/office-ui";
import type { DocxComment } from "../../../../_shared/office-engine/index";
import { type CommentThread, MAX_COMMENT_LENGTH, REVIEW_SHORTCUTS, type ReviewController, excerptOf, formatReviewDate } from "../../review/index";
import { useReviewSnapshot } from "./use-review";
import "./review.css";

/** Ctrl/Cmd+Enter sends from a comment box. */
function submitOnShortcut(event: KeyboardEvent, submit: () => void): void {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    submit();
  }
}

function CommentBody({ comment }: { comment: DocxComment }) {
  return (
    <div className="docs-comments__comment">
      <Avatar name={comment.author} size={24} />
      <div className="docs-comments__comment-main">
        <div className="docs-comments__meta">
          <span className="docs-comments__author">{comment.author}</span>
          <span className="docs-comments__date">{formatReviewDate(comment.date)}</span>
        </div>
        <p className="docs-comments__text">{comment.text}</p>
      </div>
    </div>
  );
}

interface ThreadCardProps {
  thread: CommentThread;
  active: boolean;
  controller: ReviewController;
  busy: boolean;
}

function ThreadCard({ thread, active, controller, busy }: ThreadCardProps) {
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState("");
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (active && typeof card.current?.scrollIntoView === "function") card.current.scrollIntoView({ block: "nearest" });
  }, [active]);
  const sendReply = () => {
    if (controller.reply(thread.id, draft).ok) {
      setDraft("");
      setReplying(false);
    }
  };
  const quote = thread.range === null ? "The commented text was removed" : `“${excerptOf(thread.anchorText, 80)}”`;
  return (
    <article ref={card} className={active ? "docs-comments__thread is-active" : "docs-comments__thread"} aria-current={active ? "true" : undefined} data-thread-id={thread.id}>
      <button type="button" className="docs-comments__anchor" disabled={thread.range === null} onClick={() => controller.selectThread(thread.id)} aria-label={`Show in document: ${quote}`}>
        {quote}
      </button>
      <CommentBody comment={thread.root} />
      {thread.replies.map((reply) => (
        <CommentBody key={reply.id} comment={reply} />
      ))}
      {replying ? (
        <div className="docs-comments__reply">
          <TextField
            label={`Reply to ${thread.root.author}`}
            hideLabel
            multiline
            rows={2}
            value={draft}
            onChange={setDraft}
            placeholder="Reply"
            autoFocus
            maxLength={MAX_COMMENT_LENGTH}
            inputProps={{ onKeyDown: (event) => submitOnShortcut(event, sendReply) }}
          />
          <div className="docs-comments__actions">
            <button type="button" className="oui-button oui-button--primary" disabled={busy || draft.trim() === ""} onClick={sendReply}>
              Reply
            </button>
            <button type="button" className="oui-button oui-button--ghost" onClick={() => setReplying(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="docs-comments__actions">
          {!thread.resolved && (
            <button type="button" className="oui-button oui-button--ghost" disabled={busy} onClick={() => setReplying(true)}>
              Reply
            </button>
          )}
          <button type="button" className="oui-button oui-button--ghost" disabled={busy} onClick={() => controller.resolveThread(thread.id, !thread.resolved)}>
            {thread.resolved ? "Reopen" : "Resolve"}
          </button>
        </div>
      )}
    </article>
  );
}

export interface CommentsPanelProps {
  controller: ReviewController;
  busy?: boolean;
  className?: string;
  /** Moves focus to the comment box (for example after the comment shortcut opened this panel); `onComposerFocused` is called once it has. */
  focusComposer?: boolean;
  onComposerFocused?: () => void;
}

/**
 * Comment threads anchored to the document: add one on the editor
 * selection, reply, resolve or reopen, and click a thread to show its text.
 */
export function CommentsPanel({ controller, busy = false, className, focusComposer = false, onComposerFocused }: CommentsPanelProps) {
  const snapshot = useReviewSnapshot(controller);
  const [draft, setDraft] = useState("");
  const composer = useRef<HTMLDivElement>(null);
  const lastRequest = useRef(snapshot.composeRequest);

  useEffect(() => {
    if (snapshot.composeRequest === lastRequest.current) return;
    lastRequest.current = snapshot.composeRequest;
    composer.current?.querySelector("textarea")?.focus();
  }, [snapshot.composeRequest]);

  useEffect(() => {
    if (!focusComposer) return;
    composer.current?.querySelector("textarea")?.focus();
    onComposerFocused?.();
  }, [focusComposer, onComposerFocused]);

  const send = () => {
    if (controller.addComment(draft).ok) setDraft("");
  };

  const { visibleThreads, threads, activeThread, showResolved, commentError: error } = snapshot;
  const resolvedCount = threads.filter((thread) => thread.resolved).length;
  return (
    <section className={className === undefined ? "docs-comments" : `docs-comments ${className}`} aria-label="Comments">
      <div ref={composer} className="docs-comments__composer">
        <TextField
          label="New comment"
          hint={
            <>
              Comments on the selected text. <KeyHint keys={REVIEW_SHORTCUTS.comment} /> starts one.
            </>
          }
          multiline
          rows={3}
          value={draft}
          onChange={setDraft}
          placeholder="Select text in the document, then write a comment"
          maxLength={MAX_COMMENT_LENGTH}
          disabled={busy}
          inputProps={{ onKeyDown: (event) => submitOnShortcut(event, send) }}
        />
        <button type="button" className="oui-button oui-button--primary" disabled={busy || draft.trim() === ""} onClick={send}>
          Comment
        </button>
      </div>
      {error !== null && (
        <div className="docs-review__error" role="alert">
          <span>{error}</span>
          <button type="button" className="oui-button oui-button--ghost" onClick={() => controller.dismissError()}>
            Dismiss
          </button>
        </div>
      )}
      <div className="docs-comments__toolbar">
        <span className="docs-comments__count">
          {visibleThreads.length} {visibleThreads.length === 1 ? "thread" : "threads"}
        </span>
        <Checkbox label={`Show resolved (${resolvedCount})`} checked={showResolved} onChange={(checked) => controller.setShowResolved(checked)} />
      </div>
      {visibleThreads.length === 0 ? (
        <EmptyState headline={threads.length === 0 ? "No comments yet" : "No open comments"} description="Select text in the document and write a comment to start a thread." />
      ) : (
        <div className="docs-comments__threads">
          {visibleThreads.map((thread) => (
            <ThreadCard key={thread.id} thread={thread} active={activeThread?.id === thread.id} controller={controller} busy={busy} />
          ))}
        </div>
      )}
    </section>
  );
}
