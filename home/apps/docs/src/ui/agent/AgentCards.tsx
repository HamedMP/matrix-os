/**
 * Bodies of the Assistant result cards: the proposed revisions with jump
 * links and review actions, and answers with clickable citations. All text
 * that came from the model or the document is rendered as text.
 */

import { describeChange } from "../../agent/index";
import type { AnswerSegment, ChangeSummaryItem, CommentSummaryItem } from "../../agent/index";
import type { BlockId, TextRange } from "../../../../_shared/office-engine/index";
import type { AssistantCard } from "./assistant-store";

/** Where a jump link goes: a block, or a range inside it. */
export interface JumpTarget {
  blockId: BlockId;
  range: TextRange | null;
}

export interface EditCardBodyProps {
  card: Extract<AssistantCard, { type: "edit" }>;
  /** Revisions of the card still pending. */
  pendingCount: number;
  onJump: (target: JumpTarget) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onReviewOneByOne: () => void;
  disabled?: boolean;
}

const MAX_LISTED = 50;

export function EditCardBody({ card, pendingCount, onJump, onAcceptAll, onRejectAll, onReviewOneByOne, disabled = false }: EditCardBodyProps) {
  const changes = card.changes.slice(0, MAX_LISTED);
  const comments = card.comments.slice(0, MAX_LISTED);
  return (
    <div className="docs-agent-card">
      {card.summary !== null && <p className="docs-agent-card__summary">{card.summary}</p>}
      {card.notes.map((note) => (
        <p key={note} className="docs-agent-card__note">{note}</p>
      ))}
      {changes.length > 0 && (
        <ul className="docs-agent-card__list" aria-label="Proposed revisions">
          {changes.map((change) => (
            <li key={change.revisionIds.join(",")}>
              <ChangeLink change={change} onJump={onJump} />
            </li>
          ))}
        </ul>
      )}
      {card.changes.length > MAX_LISTED && <p className="docs-agent-card__note">{card.changes.length - MAX_LISTED} more revisions are in the document.</p>}
      {comments.length > 0 && (
        <ul className="docs-agent-card__list" aria-label="Comments added">
          {comments.map((comment) => (
            <li key={comment.commentId}>
              <CommentLink comment={comment} onJump={onJump} />
            </li>
          ))}
        </ul>
      )}
      {pendingCount > 0 && (
        <div className="docs-agent-card__actions">
          <button type="button" className="oui-button oui-button--success" onClick={onAcceptAll} disabled={disabled}>Accept all</button>
          <button type="button" className="oui-button oui-button--danger" onClick={onRejectAll} disabled={disabled}>Reject all</button>
          <button type="button" className="oui-button" onClick={onReviewOneByOne} disabled={disabled}>Review one by one</button>
        </div>
      )}
    </div>
  );
}

function ChangeLink({ change, onJump }: { change: ChangeSummaryItem; onJump: (target: JumpTarget) => void }) {
  return (
    <button type="button" className="docs-agent-card__link" data-kind={change.kind} onClick={() => onJump({ blockId: change.blockId, range: change.range })}>
      {describeChange(change)}
    </button>
  );
}

function CommentLink({ comment, onJump }: { comment: CommentSummaryItem; onJump: (target: JumpTarget) => void }) {
  const label = `Comment on “${comment.anchorText}”: ${comment.text}`;
  if (comment.blockId === null) return <span className="docs-agent-card__link">{label}</span>;
  return (
    <button type="button" className="docs-agent-card__link" data-kind="comment" onClick={() => onJump({ blockId: comment.blockId as BlockId, range: comment.range })}>
      {label}
    </button>
  );
}

export function AnswerBody({ segments, onJump }: { segments: readonly AnswerSegment[]; onJump: (target: JumpTarget) => void }) {
  return (
    <p className="docs-agent-answer">
      {keyed(segments).map(({ key, segment }) =>
        segment.type === "text" ? (
          <span key={key}>{segment.text}</span>
        ) : (
          <button
            key={key}
            type="button"
            className="docs-agent-cite"
            aria-label={`Go to source ${segment.number}`}
            title="Show this paragraph"
            onClick={() => onJump({ blockId: segment.blockId, range: null })}
          >
            {segment.number}
          </button>
        ),
      )}
    </p>
  );
}

/** Stable keys for answer segments: text by content, citations by block and occurrence. */
function keyed(segments: readonly AnswerSegment[]): Array<{ key: string; segment: AnswerSegment }> {
  const seen = new Map<string, number>();
  return segments.map((segment) => {
    const base = segment.type === "text" ? `t:${segment.text.slice(0, 32)}` : `c:${segment.blockId}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { key: `${base}:${count}`, segment };
  });
}
