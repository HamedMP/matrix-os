import type { ReactNode } from "react";
import type { ReleaseNotesArt, ReleaseNotesTone } from "../../../../shared/release-notes";

// Pastel layers blend toward the surface colour through `--wn-art-mix`, which
// the dialog lowers in dark theme so the panels glow instead of glare.
const mix = (color: string) => `color-mix(in srgb, ${color} var(--wn-art-mix, 100%), var(--bg-surface))`;

const TONE_BACKGROUNDS: Record<ReleaseNotesTone, string> = {
  lime: [
    `radial-gradient(120% 90% at 20% 0%, ${mix("#dfe9c2")} 0%, transparent 60%)`,
    `radial-gradient(70% 70% at 78% 30%, ${mix("#bed77b")} 0%, transparent 55%)`,
    `radial-gradient(90% 90% at 100% 100%, ${mix("#bcd6d8")} 0%, transparent 55%)`,
    "var(--bg-surface)",
  ].join(", "),
  teal: [
    `radial-gradient(110% 90% at 85% 0%, ${mix("#bcd6d8")} 0%, transparent 62%)`,
    `radial-gradient(80% 90% at 0% 100%, ${mix("#3b7f8e")} 0%, transparent 52%)`,
    `radial-gradient(60% 60% at 30% 20%, ${mix("#dfe9c2")} 0%, transparent 60%)`,
    "var(--bg-surface)",
  ].join(", "),
  sand: [
    `radial-gradient(80% 100% at 80% 0%, ${mix("#f3dcb3")} 0%, transparent 60%)`,
    `radial-gradient(70% 80% at 0% 100%, ${mix("#dfe9c2")} 0%, transparent 60%)`,
    `radial-gradient(50% 60% at 100% 100%, ${mix("#bcd6d8")} 0%, transparent 60%)`,
    "var(--bg-surface)",
  ].join(", "),
  ink: [
    "radial-gradient(60% 80% at 85% 10%, rgba(190, 215, 123, 0.22) 0%, transparent 60%)",
    "radial-gradient(70% 90% at 0% 100%, rgba(59, 127, 142, 0.32) 0%, transparent 60%)",
    "linear-gradient(135deg, #1f1e1d, #34322f)",
  ].join(", "),
};

type Palette = { card: string; line: string; ink: string; muted: string };

// Themed through CSS variables that the dialog switches for dark theme, so the
// illustrations stay legible on both the light and the dimmed gradients.
const THEMED: Palette = {
  card: "var(--wn-art-card, #fbfaf8)",
  line: "var(--wn-art-line, #e2dfda)",
  ink: "var(--wn-art-ink, #242323)",
  muted: "var(--wn-art-muted, #8b8781)",
};
const DARK: Palette = { card: "#2b2a28", line: "#45423f", ink: "#f2f0ec", muted: "#9b978f" };
const GREEN = "#3d8b4f";
const AMBER = "#d08a17";
const OLIVE = "#475926";
const LIME = "#bed77b";
const TEAL = "#3b7f8e";
const STROKE = { strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" } as const;

function star(cx: number, cy: number, r: number): string {
  return `M${cx} ${cy - r}Q${cx} ${cy} ${cx + r} ${cy}Q${cx} ${cy} ${cx} ${cy + r}Q${cx} ${cy} ${cx - r} ${cy}Q${cx} ${cy} ${cx} ${cy - r}Z`;
}

function Agents({ p }: { p: Palette }) {
  const rows = [
    { y: 38, color: AMBER, width: 78 },
    { y: 66, color: GREEN, width: 62 },
    { y: 94, color: p.muted, width: 70 },
  ];
  return (
    <>
      <rect x="30" y="14" width="180" height="112" rx="14" fill={p.card} stroke={p.line} {...STROKE} />
      <path d="M44 52H196M44 80H196" stroke={p.line} {...STROKE} />
      {rows.map(({ y, color, width }, index) => (
        <g key={y}>
          <circle cx="52" cy={y} r="9" fill={color} opacity="0.18" />
          <circle cx="52" cy={y} r="4.5" fill={color} />
          <rect x="66" y={y - 4} width={width} height="8" rx="4" fill={p.ink} opacity={index === 0 ? 0.8 : 0.45} />
          <rect x="160" y={y - 7} width="36" height="14" rx="7" fill={color} opacity="0.2" />
        </g>
      ))}
    </>
  );
}

function Terminal({ p }: { p: Palette }) {
  return (
    <>
      <rect x="24" y="16" width="192" height="108" rx="14" fill="#2b2a28" stroke="#4b4843" {...STROKE} />
      <rect x="36" y="28" width="40" height="14" rx="7" fill="#4b4843" />
      <rect x="82" y="28" width="48" height="14" rx="7" fill="#3a3835" />
      <path d="M143 35h8M147 31v8" stroke="#87827b" {...STROKE} />
      <path d="M40 70l8 6-8 6" fill="none" stroke={LIME} {...STROKE} />
      <rect x="56" y="72" width="96" height="8" rx="4" fill="#d8d4cc" opacity="0.7" />
      <rect x="158" y="70" width="6" height="12" rx="1.5" fill={LIME} />
      <path d="M40 100l4 4 8-8" fill="none" stroke={LIME} {...STROKE} />
      <rect x="58" y="96" width="70" height="8" rx="4" fill={LIME} opacity="0.55" />
    </>
  );
}

function Notification({ p }: { p: Palette }) {
  return (
    <>
      <rect x="86" y="8" width="68" height="124" rx="14" fill={p.card} stroke={p.line} {...STROKE} />
      <rect x="110" y="15" width="20" height="4" rx="2" fill={p.line} />
      <rect x="60" y="51" width="124" height="40" rx="10" fill={p.ink} opacity="0.08" />
      <rect x="58" y="46" width="124" height="40" rx="10" fill={p.card} stroke={p.line} {...STROKE} />
      <path d="M72 71v-5a6 6 0 0 1 12 0v5l2 2H70z" fill={AMBER} fillOpacity="0.2" stroke={AMBER} {...STROKE} />
      <circle cx="78" cy="76.5" r="1.6" fill={AMBER} />
      <rect x="94" y="57" width="62" height="7" rx="3.5" fill={p.ink} opacity="0.75" />
      <rect x="94" y="69" width="44" height="6" rx="3" fill={p.muted} opacity="0.55" />
      <circle cx="180" cy="48" r="6" fill={AMBER} />
      <rect x="100" y="104" width="40" height="12" rx="6" fill={p.ink} opacity="0.85" />
    </>
  );
}

function Sparkle({ p }: { p: Palette }) {
  return (
    <>
      <path d={star(120, 70, 36)} fill={LIME} stroke={OLIVE} {...STROKE} />
      <path d={star(174, 40, 13)} fill={TEAL} opacity="0.85" />
      <path d={star(70, 102, 11)} fill={AMBER} opacity="0.85" />
      <circle cx="66" cy="42" r="3.5" fill={p.ink} opacity="0.5" />
      <circle cx="180" cy="102" r="3" fill={p.ink} opacity="0.4" />
    </>
  );
}

function Shield({ p }: { p: Palette }) {
  return (
    <>
      <path
        d="M120 16l40 14v38c0 26-18 44-40 54-22-10-40-28-40-54V30z"
        fill={p.card}
        stroke={p.ink}
        {...STROKE}
      />
      <path d="M120 28l28 10v30c0 19-12 33-28 41z" fill={GREEN} opacity="0.12" />
      <path d="M104 70l11 11 22-24" fill="none" stroke={GREEN} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="62" cy="48" r="4" fill={LIME} />
      <circle cx="182" cy="96" r="5" fill={TEAL} opacity="0.7" />
    </>
  );
}

function Sync({ p }: { p: Palette }) {
  return (
    <>
      <path d="M96 42a42 42 0 0 1 52 0" fill="none" stroke={p.ink} {...STROKE} />
      <path d="M141 36l8 6-9 4" fill="none" stroke={p.ink} {...STROKE} />
      <path d="M144 98a42 42 0 0 1-52 0" fill="none" stroke={p.ink} {...STROKE} />
      <path d="M99 104l-8-6 9-4" fill="none" stroke={p.ink} {...STROKE} />
      <circle cx="88" cy="70" r="17" fill={LIME} stroke={p.ink} {...STROKE} />
      <circle cx="152" cy="70" r="17" fill={TEAL} fillOpacity="0.75" stroke={p.ink} {...STROKE} />
      <circle cx="88" cy="65" r="5" fill={p.card} />
      <path d="M79 79a10 10 0 0 1 18 0" fill={p.card} />
      <circle cx="152" cy="65" r="5" fill={p.card} />
      <path d="M143 79a10 10 0 0 1 18 0" fill={p.card} />
    </>
  );
}

const ILLUSTRATIONS: Record<ReleaseNotesArt, (props: { p: Palette }) => ReactNode> = {
  agents: Agents,
  terminal: Terminal,
  notification: Notification,
  sparkle: Sparkle,
  shield: Shield,
  sync: Sync,
};

export function HighlightArt({ art, tone, large }: {
  art: ReleaseNotesArt;
  tone: ReleaseNotesTone;
  large: boolean;
}) {
  const Illustration = ILLUSTRATIONS[art];
  return (
    <div
      data-highlight-art={art}
      data-tone={tone}
      className={`relative grid place-items-center overflow-hidden ${large ? "h-[200px]" : "h-[140px]"}`}
      style={{ background: TONE_BACKGROUNDS[tone] }}
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 240 140"
        className={large ? "h-[170px] w-auto" : "h-[118px] w-auto"}
      >
        <Illustration p={tone === "ink" ? DARK : THEMED} />
      </svg>
    </div>
  );
}

/** Soft gradient wash behind the release title. */
export const HERO_WASH = [
  "radial-gradient(55% 120% at 0% 0%, color-mix(in srgb, #dfe9c2 var(--wn-wash-mix, 55%), transparent) 0%, transparent 70%)",
  "radial-gradient(45% 100% at 100% 0%, color-mix(in srgb, #bcd6d8 var(--wn-wash-mix, 55%), transparent) 0%, transparent 70%)",
].join(", ");
