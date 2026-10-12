// Artwork for the engines a chat can run with. A glyph is a white shape on a
// transparent ground, so it is always drawn in a colour: the engine's own when
// it has one, otherwise the text colour. The other files carry their colours.
export const providerArtwork = {
  claude: { source: require("../../../shell/public/agent-logos/claude-code.png"), glyph: true, brandColor: "#E3925A" },
  codex: { source: require("../../../shell/public/agent-logos/codex.png"), glyph: true, brandColor: null },
  hermes: { source: require("../../../shell/public/agent-logos/hermes-agent.png"), glyph: false, brandColor: null },
  openclaw: { source: require("../../../shell/public/agent-logos/openclaw.svg"), glyph: false, brandColor: null },
  opencode: { source: require("../../../shell/public/agent-logos/opencode-white.png"), glyph: true, brandColor: null },
  pi: { source: require("../../../shell/public/agent-logos/pi-coding-agent.png"), glyph: true, brandColor: null },
} as const;

export type ArtworkProvider = keyof typeof providerArtwork;
