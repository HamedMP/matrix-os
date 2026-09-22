import type { CanonicalProviderDriverKind } from "@matrix-os/contracts";
import { CODING_AGENT_ARTWORK } from "@matrix-os/ui";
import { Cpu } from "@renderer/lib/hugeicons";
import hermesProviderIcon from "../../assets/providers/hermes-provider.png";

export function ProviderDriverGlyph({ kind, size = 15 }: {
  kind: CanonicalProviderDriverKind;
  size?: number;
}) {
  if (kind === "hermes") {
    return <img aria-hidden alt="" data-provider-glyph={kind} src={hermesProviderIcon}
      width={size} height={size} className="shrink-0 object-cover"
      style={{ borderRadius: Math.max(3, Math.round(size * 0.2)), height: size, width: size }} />;
  }
  if (kind === "openclaw") {
    return <span aria-hidden data-provider-glyph={kind}
      className="inline-flex items-center justify-center leading-none"
      style={{ fontSize: size + 2, height: size, width: size }}>🦞</span>;
  }
  if (kind === "claude_code" || kind === "codex" || kind === "opencode" || kind === "pi") {
    const artwork = CODING_AGENT_ARTWORK[kind === "claude_code" ? "claude" : kind];
    const imageSize = Math.round(size * 0.68);
    return <span aria-hidden data-provider-glyph={kind}
      className="inline-flex shrink-0 items-center justify-center overflow-hidden"
      style={{ background: artwork.background, borderRadius: Math.max(3, Math.round(size * 0.2)), height: size, width: size }}>
      <img alt="" draggable={false} src={artwork.src} width={imageSize} height={imageSize}
        className="block object-contain" style={{ width: imageSize, height: imageSize }} />
    </span>;
  }
  return <Cpu data-provider-glyph={kind} size={size} aria-hidden />;
}
