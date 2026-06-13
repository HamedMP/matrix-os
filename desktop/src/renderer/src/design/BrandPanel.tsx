import type { CSSProperties, ReactNode } from "react";
import matrixLogoUrl from "../assets/matrix-logo.svg";

// The real Matrix OS brand glyph, recolored to the current theme via CSS mask
// (works in light + dark since it picks up the brand color, not a baked fill).
export function BrandLogo({ size = 22, color = "var(--accent)" }: { size?: number; color?: string }) {
  const style: CSSProperties = {
    width: Math.round((size * 510) / 660),
    height: size,
    background: color,
    WebkitMaskImage: `url(${matrixLogoUrl})`,
    maskImage: `url(${matrixLogoUrl})`,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
    maskSize: "contain",
    WebkitMaskPosition: "center",
    maskPosition: "center",
  };
  return <span aria-hidden style={style} />;
}

// The dark forest brand panel used on the sign-in split screen. The dotted
// mesh evokes the Matrix wordmark without shipping a raster asset.
export function MatrixMark({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden>
      <g fill="currentColor">
        {[
          [10, 34], [16, 30], [10, 26], [16, 22], [10, 18], [16, 14],
          [24, 18], [24, 26],
          [32, 14], [38, 18], [32, 22], [38, 26], [32, 30], [38, 34],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 3 : 2.2} opacity={0.55 + (i % 4) * 0.12} />
        ))}
      </g>
    </svg>
  );
}

function MeshBackdrop() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 400 600"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <defs>
        <radialGradient id="op-mesh-a" cx="30%" cy="20%" r="60%">
          <stop offset="0%" stopColor="#fafaf5" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#fafaf5" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="op-mesh-b" cx="80%" cy="75%" r="55%">
          <stop offset="0%" stopColor="#8cc7be" stopOpacity="0.1" />
          <stop offset="100%" stopColor="#8cc7be" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="600" fill="url(#op-mesh-a)" />
      <rect width="400" height="600" fill="url(#op-mesh-b)" />
      <g fill="#fafaf5" opacity="0.05">
        {Array.from({ length: 60 }).map((_, i) => {
          const x = (i * 71) % 400;
          const y = (i * 113) % 600;
          return <circle key={i} cx={x} cy={y} r={(i % 4) + 1.5} />;
        })}
      </g>
    </svg>
  );
}

export function BrandPanel({
  title,
  subtitle,
  bullets,
}: {
  title: ReactNode;
  subtitle: string;
  bullets: { icon: ReactNode; label: string }[];
}) {
  return (
    <div
      className="relative flex flex-col justify-between overflow-hidden p-10"
      style={{
        background: `linear-gradient(160deg, var(--forest) 0%, var(--forest-deep) 100%)`,
        color: "var(--forest-foreground)",
      }}
    >
      <MeshBackdrop />
      <div className="relative flex items-center gap-2.5">
        <MatrixMark size={34} />
        <span className="text-lg font-semibold tracking-tight">Matrix OS</span>
      </div>

      <div className="relative flex flex-col gap-4">
        <h1 className="text-2xl leading-tight font-semibold tracking-tight" style={{ fontSize: "var(--text-2xl)" }}>
          {title}
        </h1>
        <p className="max-w-[300px] text-md leading-relaxed" style={{ color: "var(--forest-muted)" }}>
          {subtitle}
        </p>
      </div>

      <ul className="relative flex flex-col gap-3">
        {bullets.map((b) => (
          <li key={b.label} className="flex items-center gap-2.5 text-sm">
            <span style={{ color: "var(--forest-foreground)", opacity: 0.85 }}>{b.icon}</span>
            <span style={{ color: "var(--forest-muted)" }}>{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
