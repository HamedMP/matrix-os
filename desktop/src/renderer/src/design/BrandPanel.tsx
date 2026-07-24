import type { CSSProperties, ReactNode } from "react";
import matrixLogoUrl from "../assets/matrix-logo.svg";

// The real Matrix OS brand glyph, recolored to the current theme via CSS mask
// (works in light + dark since it picks up the brand color, not a baked fill).
export function BrandLogo({
  size = 22,
  color = "var(--accent)",
  className,
  testId,
  style: styleOverride,
}: {
  size?: number;
  color?: string;
  className?: string;
  testId?: string;
  style?: CSSProperties;
}) {
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
  return <span aria-hidden className={className} data-testid={testId} style={{ ...styleOverride, ...style }} />;
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
      <g fill="#fafaf5" opacity="0.035">
        {Array.from({ length: 60 }).map((_, i) => {
          const x = (i * 71) % 400;
          const y = (i * 113) % 600;
          return <circle key={i} cx={x} cy={y} r={(i % 3) + 1.2} />;
        })}
      </g>
    </svg>
  );
}

function AmbientLogoMark() {
  return (
    <BrandLogo
      size={1240}
      color="rgba(250, 250, 245, 0.72)"
      testId="matrix-brand-ambient-mark"
      className="pointer-events-none absolute -right-28 top-10 opacity-[0.105] blur-[0.2px] drop-shadow-[0_46px_90px_rgba(0,0,0,0.32)]"
    />
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
        background:
          "radial-gradient(circle at 80% 10%, rgba(250,250,245,0.12), transparent 28%), radial-gradient(circle at 12% 88%, rgba(208,111,37,0.13), transparent 32%), linear-gradient(160deg, var(--brand-forest) 0%, var(--brand-forest-deep) 100%)",
        color: "var(--brand-forest-foreground)",
      }}
    >
      <MeshBackdrop />
      <AmbientLogoMark />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/18 to-transparent" aria-hidden />

      <div className="relative flex items-center gap-3">
        <span className="flex size-11 items-center justify-center rounded-2xl bg-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_18px_38px_rgba(0,0,0,0.18)] ring-1 ring-white/12 backdrop-blur">
          <BrandLogo size={25} color="var(--brand-forest-foreground)" testId="matrix-brand-visible-mark" />
        </span>
        <span className="text-lg font-semibold tracking-tight drop-shadow-[0_1px_12px_rgba(0,0,0,0.22)]">Matrix OS</span>
      </div>

      <div className="relative flex max-w-[420px] flex-col gap-5">
        <div className="inline-flex w-fit items-center gap-2 rounded-full border border-white/10 bg-white/8 px-3 py-1 text-[11px] font-medium uppercase tracking-[0.18em] text-white/70 shadow-[0_12px_28px_rgba(0,0,0,0.14)] backdrop-blur">
          <span className="size-1.5 rounded-full bg-[#d06f25] shadow-[0_0_18px_rgba(208,111,37,0.7)]" />
          Private cloud workspace
        </div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight drop-shadow-[0_18px_42px_rgba(0,0,0,0.22)]" style={{ fontSize: "var(--text-2xl)" }}>
          {title}
        </h1>
        <p className="max-w-[330px] text-md leading-relaxed" style={{ color: "var(--brand-forest-muted)" }}>
          {subtitle}
        </p>
      </div>

      <ul className="relative flex w-fit flex-col gap-3 rounded-2xl border border-white/10 bg-black/10 p-4 shadow-[0_22px_60px_rgba(0,0,0,0.16)] backdrop-blur">
        {bullets.map((b) => (
          <li key={b.label} className="flex items-center gap-2.5 text-sm">
            <span className="flex size-7 items-center justify-center rounded-lg bg-white/8 ring-1 ring-white/10" style={{ color: "var(--brand-forest-foreground)", opacity: 0.92 }}>
              {b.icon}
            </span>
            <span style={{ color: "var(--brand-forest-muted)" }}>{b.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
