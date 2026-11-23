import { CODING_AGENT_ARTWORK } from "./coding-agent-artwork.js";

/** Agents with a shipped logo; every one has artwork in CODING_AGENT_ARTWORK. */
export type AgentLogoKind = keyof typeof CODING_AGENT_ARTWORK;

export function isAgentLogoKind(value: string): value is AgentLogoKind {
  return Object.hasOwn(CODING_AGENT_ARTWORK, value);
}
