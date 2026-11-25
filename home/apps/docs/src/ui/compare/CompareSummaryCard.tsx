/**
 * The result of a comparison: the substantive-change answer, counts by kind,
 * and the changes with jump links. Changed text is document text and is
 * rendered as text.
 */

import { useId } from "react";
import { Badge } from "../../../../_shared/office-ui";
import type { CompareFlowResult } from "../../compare/index";

const MAX_LISTED = 60;
const PREVIEW = 100;

const KIND_LABEL: Record<string, string> = {
  insert: "Inserted",
  delete: "Deleted",
  moveFrom: "Moved from",
  moveTo: "Moved to",
  format: "Formatting",
};

function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW ? `${flat.slice(0, PREVIEW - 1)}…` : flat;
}

export interface CompareSummaryCardProps {
  result: Extract<CompareFlowResult, { status: "compared" }>;
  onJump: (blockId: string) => void;
}

export function CompareSummaryCard({ result, onJump }: CompareSummaryCardProps) {
  const { summary, answer, counts } = result;
  const listed = summary.changes.slice(0, MAX_LISTED);
  const questionId = useId();
  return (
    <article className="docs-compare__result" aria-labelledby={questionId}>
      <h3 id={questionId} className="docs-compare__title">Did anything substantive change?</h3>
      <p className="docs-compare__answer" data-changed={answer.changed}>
        <Badge tone={answer.changed ? "warning" : "success"}>{answer.changed ? "Yes" : "No"}</Badge> {answer.headline.replace(/^(Yes|No)\. /, "")}
      </p>
      <p className="docs-compare__hint">{answer.detail}</p>
      {counts.length > 0 && (
        <dl className="docs-compare__counts">
          {counts.map((entry) => (
            <div key={entry.label}>
              <dt>{entry.label}</dt>
              <dd>{entry.count}</dd>
            </div>
          ))}
          <div>
            <dt>Substantive</dt>
            <dd>{summary.substantive}</dd>
          </div>
          <div>
            <dt>Formatting only</dt>
            <dd>{summary.formattingOnly}</dd>
          </div>
        </dl>
      )}
      <p className="docs-compare__hint">Opened as “{result.name}” in the markup view. Save it to keep it.</p>
      {listed.length > 0 && (
        <ul className="docs-compare__changes" aria-label="Changes">
          {listed.map((change) => (
            <li key={change.revisionId}>
              <button type="button" className="docs-compare__change" data-kind={change.kind} onClick={() => onJump(change.blockIds[0] as string)}>
                <span className="docs-compare__kind">{KIND_LABEL[change.kind] ?? change.kind}</span>
                {change.classification === "formatting" && <Badge>Formatting only</Badge>} “{preview(change.text)}”
              </button>
            </li>
          ))}
        </ul>
      )}
      {summary.changes.length > MAX_LISTED && <p className="docs-compare__hint">{summary.changes.length - MAX_LISTED} more changes are in the document.</p>}
    </article>
  );
}
