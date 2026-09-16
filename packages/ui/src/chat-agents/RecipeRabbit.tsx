import type { CSSProperties } from "react";

export type RabbitState = "idle" | "attention" | "working" | "success" | "blocked";
export type RabbitSize = "small" | "medium" | "large";

const palettes = [
  { name: "teal", ink: "#35B7A7", wash: "#DDF6F1", accent: "#0E6F67" },
  { name: "violet", ink: "#6D63E8", wash: "#ECEAFF", accent: "#4137A9" },
  { name: "coral", ink: "#F07A61", wash: "#FFE9E3", accent: "#A63E31" },
  { name: "blue", ink: "#4388E8", wash: "#E5F0FF", accent: "#2358A2" },
  { name: "plum", ink: "#A95EA4", wash: "#F7E7F5", accent: "#71376D" },
  { name: "moss", ink: "#75A951", wash: "#EAF5E1", accent: "#406D2A" },
  { name: "amber", ink: "#F1A23E", wash: "#FFF1D9", accent: "#9B5D14" },
  { name: "rose", ink: "#D86691", wash: "#FCE8F0", accent: "#923858" },
] as const;

const taskPalette = new Map([
  ["sales", 2], ["marketing", 4], ["operations", 6], ["finance", 5],
  ["research", 3], ["engineering", 1], ["productivity", 0], ["creative", 7],
]);

const facePaths = [
  "M7 29C7 18 14 11 24 11s17 7 17 18c0 10-7 16-17 16S7 39 7 29Z",
  "M6 31C7 18 16 9 27 11c10 2 16 11 14 21-2 9-10 14-20 13C11 44 5 39 6 31Z",
  "M9 39C4 32 8 19 21 10c3-2 6-2 9 0 11 8 15 20 10 28-6 9-23 10-31 1Z",
  "M5 28c0-11 8-18 19-18s19 7 19 18-7 17-19 17S5 39 5 28Z",
] as const;

const earPaths = [
  ["M12 20C10 14 10 5 15 2c6 1 7 11 5 18Z", "M28 20C27 12 29 2 35 2c5 4 2 14-1 19Z"],
  ["M13 20C9 14 10 6 15 3c5 1 7 10 5 17Z", "M28 20C27 12 30 4 35 3c5 4 2 13-1 18Z"],
  ["M14 20C12 13 13 5 17 2c5 3 5 12 3 18Z", "M28 20c0-8 3-16 7-18 5 4 3 14-1 19Z"],
] as const;

function rabbitHash(value: string) {
  let hash = 0;
  for (const character of value) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return hash;
}

function normalizeTask(category?: string) {
  const normalized = category?.trim().toLocaleLowerCase() ?? "general";
  for (const task of taskPalette.keys()) if (normalized.includes(task)) return task;
  return "general";
}

export function RecipeRabbit({
  id,
  name,
  category,
  state = "idle",
  size = "medium",
  avatar = false,
}: {
  id: string;
  name: string;
  category?: string;
  state?: RabbitState;
  size?: RabbitSize;
  avatar?: boolean;
}) {
  const hash = rabbitHash(id);
  const task = normalizeTask(category);
  const taskIndex = taskPalette.get(task);
  const paletteIndex = taskIndex ?? hash % palettes.length;
  const palette = palettes[paletteIndex]!;
  const variant = hash % facePaths.length;
  const ears = earPaths[hash % earPaths.length]!;
  const style = {
    "--rabbit-ink": palette.ink,
    "--rabbit-wash": palette.wash,
    "--rabbit-accent": palette.accent,
    "--rabbit-delay": `${-(hash % 41) / 10}s`,
  } as CSSProperties;

  return <span
    data-recipe-rabbit={avatar ? undefined : id}
    data-agent-avatar={avatar ? id : undefined}
    data-rabbit-variant={`${variant}-${paletteIndex}-${id}`}
    data-rabbit-state={state}
    data-rabbit-task={task}
    data-rabbit-color={palette.name}
    aria-hidden="true"
    title={`${name} rabbit — ${state}`}
    className={`matrix-recipe-rabbit matrix-recipe-rabbit--${size} matrix-recipe-rabbit--shape-${variant}`}
    style={style}
  >
    <svg viewBox="0 0 48 48" focusable="false">
      <g className="matrix-agent-rabbit__ears">
        <g className="matrix-agent-rabbit__ear matrix-agent-rabbit__ear--left">
          <path d={ears[0]} fill="var(--rabbit-ink)" />
          <path className="matrix-agent-rabbit__inner-ear" d="M15.2 6.5c1.5 2.2 2.2 5.4 2.2 8.3" fill="none" stroke="var(--rabbit-wash)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
        <g className="matrix-agent-rabbit__ear matrix-agent-rabbit__ear--right">
          <path d={ears[1]} fill="var(--rabbit-ink)" />
          <path className="matrix-agent-rabbit__inner-ear" d="M34.5 6.5c-1.5 2.2-2.2 5.4-2.2 8.3" fill="none" stroke="var(--rabbit-wash)" strokeWidth="1.4" strokeLinecap="round" />
        </g>
      </g>
      <path className="matrix-agent-rabbit__face" d={facePaths[variant]} fill="var(--rabbit-ink)" />
      <g className="matrix-agent-rabbit__eyes" fill="var(--rabbit-eye, #17201f)">
        <rect x={variant % 2 ? 15 : 14} y="25" width="3.2" height="6" rx="1.6" transform="rotate(-12 15.6 28)" />
        <g className="matrix-agent-rabbit__wink"><rect x={variant % 2 ? 29 : 30} y="25" width="3.2" height="6" rx="1.6" transform="rotate(-12 31.6 28)" /></g>
      </g>
      {hash % 3 === 0 ? <circle className="matrix-agent-rabbit__nose" cx="24" cy="34" r="1.35" fill="var(--rabbit-wash)" /> : null}
      <g className="matrix-agent-rabbit__status">
        <circle className="matrix-agent-rabbit__status-ring" cx="39.5" cy="10" r="5" fill="var(--rabbit-wash)" />
        <circle className="matrix-agent-rabbit__status-dot" cx="39.5" cy="10" r="2.6" fill="var(--rabbit-accent)" />
        <path className="matrix-agent-rabbit__status-spark" d="M39.5 4.5c.6 3.3 1.7 4.4 5 5-3.3.6-4.4 1.7-5 5-.6-3.3-1.7-4.4-5-5 3.3-.6 4.4-1.7 5-5Z" fill="var(--rabbit-wash)" />
        <path className="matrix-agent-rabbit__status-minus" d="M37.5 10h4" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </g>
    </svg>
  </span>;
}
