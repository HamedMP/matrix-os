/**
 * The bodies of agent result cards. Every string here came from a mailbox or
 * the model and is rendered as text only.
 */
import type { DraftProposal } from "../../agent/proposals";
import type { AgenticSearchResult, RankedThread } from "../../agent/search";
import type { ThreadDigest } from "../../agent/summarize";
import type { TriageSuggestion } from "../../agent/triage";
import { Checkbox } from "../../../../_shared/office-ui";

export function DraftBody({ proposal, onKeep, onDiscard }: { proposal: DraftProposal; onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className="mail-agent__draft">
      {proposal.saveFailed && <p className="mail-agent__note">Not saved to your mailbox yet. The composer keeps trying.</p>}
      <p className="mail-agent__preview">{proposal.proposed}</p>
      {proposal.status === "proposed" && (
        <div className="mail-agent__actions">
          <button type="button" className="oui-button oui-button--primary" onClick={onKeep}>Keep draft</button>
          <button type="button" className="oui-button oui-button--danger" onClick={onDiscard}>Discard</button>
        </div>
      )}
    </div>
  );
}

function List({ label, items }: { label: string; items: readonly string[] }) {
  if (!items.length) return null;
  return (
    <div className="mail-agent__list">
      <h4 className="mail-agent__list-title">{label}</h4>
      <ul>
        {items.map((item, i) => (
          <li key={`${i}-${item}`}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export function SummaryBody({ digest }: { digest: ThreadDigest }) {
  return (
    <div className="mail-agent__summary">
      <p>{digest.summary}</p>
      <List label="Key points" items={digest.keyPoints} />
      <List label="Open asks" items={digest.actionItems} />
      <List label="Attachments" items={digest.attachments} />
    </div>
  );
}

export function SearchBody({ result, onOpen }: { result: AgenticSearchResult; onOpen: (thread: RankedThread) => void }) {
  if (!result.results.length) return <p className="mail-agent__note">No matching conversations.</p>;
  return (
    <ol className="mail-agent__hits">
      {result.results.map((hit) => (
        <li key={hit.key} className="mail-agent__hit">
          <button type="button" className="mail-agent__hit-open" onClick={() => onOpen(hit)}>
            <span className="mail-agent__hit-subject">{hit.subject || "(no subject)"}</span>
            <span className="mail-agent__hit-meta">{[hit.from, hit.lastMessageAt.slice(0, 10)].filter(Boolean).join(" · ")}</span>
          </button>
          <span className="mail-agent__hit-reason">{hit.reason}</span>
        </li>
      ))}
      {!result.ranked && <li className="mail-agent__note">Shown in date and match order; the assistant could not rank them.</li>}
    </ol>
  );
}

const ACTION_LABEL: Record<TriageSuggestion["action"], string> = {
  archive: "Archive",
  move: "Move to",
  flag: "Flag",
  markRead: "Mark read",
};

export function TriageBody({
  suggestions,
  status,
  outcome,
  onToggle,
  onApply,
  onDismiss,
}: {
  suggestions: readonly TriageSuggestion[];
  status: "proposed" | "applying" | "applied" | "dismissed";
  outcome: { applied: number; failed: number } | null;
  onToggle: (id: string, selected: boolean) => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  if (!suggestions.length) return <p className="mail-agent__note">Nothing to change.</p>;
  const selected = suggestions.filter((s) => s.selected).length;
  return (
    <div className="mail-agent__triage">
      <ul className="mail-agent__triage-list">
        {suggestions.map((s) => (
          <li key={s.id}>
            <Checkbox
              label={`${ACTION_LABEL[s.action]}${s.folderName ? ` ${s.folderName}` : ""}: ${s.subject || "(no subject)"}`}
              description={s.reason}
              checked={s.selected}
              disabled={status !== "proposed"}
              onChange={(checked) => onToggle(s.id, checked)}
            />
          </li>
        ))}
      </ul>
      {status === "proposed" && (
        <div className="mail-agent__actions">
          <button type="button" className="oui-button oui-button--primary" disabled={selected === 0} onClick={onApply}>
            Apply {selected} {selected === 1 ? "change" : "changes"}
          </button>
          <button type="button" className="oui-button" onClick={onDismiss}>Dismiss</button>
        </div>
      )}
      {status === "applying" && <p className="mail-agent__note">Applying…</p>}
      {status === "applied" && outcome && (
        <p className="mail-agent__note">
          Applied to {outcome.applied} {outcome.applied === 1 ? "conversation" : "conversations"}
          {outcome.failed ? `; ${outcome.failed} could not be changed` : ""}. Use Undo in the list to reverse the last change.
        </p>
      )}
    </div>
  );
}
