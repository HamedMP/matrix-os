/** Canonical shipped Terminal artwork; Electron also serves shell/public. */
export const CODING_AGENT_ARTWORK = {
  claude: { src: "/agent-logos/claude-code.png", background: "#D8792C" },
  codex: { src: "/agent-logos/codex.png", background: "#465243" },
  // Hermes artwork already ships in the legacy Desktop renderer; OpenClaw uses its upstream Molty mark.
  hermes: { src: "/agent-logos/hermes-agent.png", background: "#FFFFFF" },
  openclaw: { src: "/agent-logos/openclaw.svg", background: "#172023" },
  opencode: { src: "/agent-logos/opencode-white.png", background: "#111111" },
  pi: { src: "/agent-logos/pi-coding-agent.png", background: "#1E2F5C" },
} as const;

/** Packaged Electron serves public assets beside index.html; web serves them at the origin root. */
export function codingAgentArtworkSrc(src: string, baseUri = typeof document === "undefined" ? "" : document.baseURI): string {
  return baseUri.startsWith("file:") ? `.${src}` : src;
}
