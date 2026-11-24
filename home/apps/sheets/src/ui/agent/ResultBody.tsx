import type { ReactNode } from "react";
import type { AgentResult } from "../../../../_shared/office-ui";
import type { AnswerResult, AssistantResult, Finding, FindingsResult, ProposalResult, SheetsAssistant } from "../../agent";

const KIND_LABEL: Record<Finding["kind"], string> = {
  hardcoded: "Typed-in value",
  "total-mismatch": "Total disagrees",
  "sum-gap": "Sum leaves cells out",
};

function ProposalActions({ result, assistant }: { result: ProposalResult; assistant: SheetsAssistant }) {
  return (
    <div className="sheets-agent__actions">
      {result.pending < result.changeCount && result.pending > 0 && <span className="sheets-agent__note">{result.pending} still pending</span>}
      <button type="button" className="oui-button oui-button--success" onClick={() => assistant.acceptResult(result.id)}>
        Accept all
      </button>
      <button type="button" className="oui-button oui-button--danger" onClick={() => assistant.rejectResult(result.id)}>
        Reject all
      </button>
      <button type="button" className="oui-button oui-button--ghost" onClick={() => assistant.reviewResult(result.id)}>
        Review
      </button>
    </div>
  );
}

function Answer({ result, assistant }: { result: AnswerResult; assistant: SheetsAssistant }) {
  const seen = new Map<string, number>();
  const paragraphs = result.text
    .split(/\n+/)
    .filter((line) => line.trim() !== "")
    .map((text) => {
      const count = (seen.get(text) ?? 0) + 1;
      seen.set(text, count);
      return { text, key: `${count}:${text}` };
    });
  return (
    <div className="sheets-agent__answer">
      {paragraphs.map((paragraph) => (
        <p key={paragraph.key}>{paragraph.text}</p>
      ))}
      <button type="button" className="oui-button oui-button--ghost" onClick={() => assistant.clearHighlights()}>
        Clear highlights
      </button>
    </div>
  );
}

function Findings({ result, assistant }: { result: FindingsResult; assistant: SheetsAssistant }) {
  if (result.findings.length === 0) return <p className="sheets-agent__note">Every total adds up and no typed-in number sits among formulas.</p>;
  return (
    <ul className="sheets-agent__findings">
      {result.findings.map((finding) => (
        <li key={`${finding.kind}|${finding.location}`} className={`sheets-agent__finding is-${finding.kind}`}>
          <span className="sheets-agent__finding-kind">{KIND_LABEL[finding.kind]}</span>
          <span className="sheets-agent__finding-text">{finding.message}</span>
          <span className="sheets-agent__actions">
            <button type="button" className="oui-button oui-button--ghost" onClick={() => assistant.showFinding(finding)} aria-label={`Go to ${finding.location}`}>
              Go to
            </button>
            {finding.kind === "total-mismatch" && finding.related !== undefined && (
              <button type="button" className="oui-button oui-button--primary" onClick={() => void assistant.fix(finding)} aria-label={`Link ${finding.location} to its calculation`}>
                Link to calculation
              </button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function body(result: AssistantResult, assistant: SheetsAssistant): ReactNode {
  switch (result.kind) {
    case "proposal":
      return result.status === "proposed" ? <ProposalActions result={result} assistant={assistant} /> : undefined;
    case "answer":
      return <Answer result={result} assistant={assistant} />;
    case "findings":
      return <Findings result={result} assistant={assistant} />;
  }
}

/** An assistant result as an office-ui result card. Proposals carry Accept all, Reject all and Review. */
export function toAgentResult(result: AssistantResult, assistant: SheetsAssistant): AgentResult {
  const meta =
    result.kind === "proposal"
      ? `${result.changeCount === 1 ? "1 change" : `${result.changeCount} changes`} · Matrix Assistant`
      : result.kind === "findings"
        ? "Checked in the app, without the model"
        : undefined;
  return {
    id: result.id,
    title: result.title,
    summary: result.summary === "" ? undefined : result.summary,
    body: body(result, assistant),
    status: result.kind === "proposal" ? result.status : "proposed",
    meta,
  };
}
