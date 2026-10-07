import { codingAgentArtworkSrc } from "../coding-agent-artwork.js";

export function ConnectionMethodCard({ title, description, recommended = false, selected = false, disabled, onClick, method, tooltip }: {
  title: string;
  description: string;
  recommended?: boolean;
  selected?: boolean;
  disabled: boolean;
  onClick?: () => void;
  method: "account" | "key";
  tooltip?: string;
}) {
  return <button type="button" className="matrix-ap-connection-choice matrix-ap-method-card" aria-pressed={selected} disabled={disabled} onClick={onClick} title={tooltip}>
    <span className="matrix-ap-method-icon" aria-hidden="true"><img src={codingAgentArtworkSrc(`/agents/settings/${method === "account" ? "user-round" : "key-round"}.svg`)} width="20" height="20" alt="" /></span>
    <span className="matrix-ap-method-copy">
      <strong>{title}{recommended ? <> <span className="matrix-ap-selected-tag">Recommended</span></> : null}</strong>
      <span>{description}</span>
    </span>
    {selected ? <span aria-hidden="true" className="matrix-ap-method-check">✓</span> : null}
  </button>;
}
