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

/** Packaged Electron serves public assets beside index.html; explicit Web VM tabs
 * must load artwork from that computer, rather than the primary shell at root. */
export function codingAgentArtworkSrc(src: string, baseUri = typeof document === "undefined" ? "" : document.baseURI): string {
  if (!src.startsWith("/") || src.startsWith("//")) return src;
  if (baseUri.startsWith("file:")) return `.${src}`;
  if (!baseUri) return src;
  let base: URL;
  try {
    base = new URL(baseUri);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    return src;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return src;
  const vm = base.pathname.match(/^\/vm\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
  if (!vm) return src;
  const pathSlot = base.pathname.slice(vm[0].length).match(/^~runtime\/([A-Za-z0-9_-]{1,32})(?:\/|$)/)?.[1];
  const querySlot = base.searchParams.get("runtime");
  const slot = pathSlot ?? (querySlot && /^[A-Za-z0-9_-]{1,32}$/.test(querySlot) ? querySlot : null);
  return `/vm/${vm[1]}${slot ? `/~runtime/${slot}` : ""}${src}`;
}
