// Mirrors the idle state of packages/ui/src/chat-agents/RecipeRabbit.tsx; keep the tables and the derivation in step with it.

const PALETTES = [
  { name: "teal", body: "#35B7A7", wash: "#DDF6F1" },
  { name: "violet", body: "#6D63E8", wash: "#ECEAFF" },
  { name: "coral", body: "#F07A61", wash: "#FFE9E3" },
  { name: "blue", body: "#4388E8", wash: "#E5F0FF" },
  { name: "plum", body: "#A95EA4", wash: "#F7E7F5" },
  { name: "moss", body: "#75A951", wash: "#EAF5E1" },
  { name: "amber", body: "#F1A23E", wash: "#FFF1D9" },
  { name: "rose", body: "#D86691", wash: "#FCE8F0" },
] as const;

// Checked in this order, so a category that names two tasks takes the first.
const TASK_PALETTES = [
  ["sales", 2],
  ["marketing", 4],
  ["operations", 6],
  ["finance", 5],
  ["research", 3],
  ["engineering", 1],
  ["productivity", 0],
  ["creative", 7],
] as const;

const FACES = [
  "M7 29C7 18 14 11 24 11s17 7 17 18c0 10-7 16-17 16S7 39 7 29Z",
  "M6 31C7 18 16 9 27 11c10 2 16 11 14 21-2 9-10 14-20 13C11 44 5 39 6 31Z",
  "M9 39C4 32 8 19 21 10c3-2 6-2 9 0 11 8 15 20 10 28-6 9-23 10-31 1Z",
  "M5 28c0-11 8-18 19-18s19 7 19 18-7 17-19 17S5 39 5 28Z",
] as const;

// `pivot` is the bottom centre of the ear's bounding box, the point the web's
// stylesheet turns the ear about.
const EARS = [
  [
    { d: "M12 20C10 14 10 5 15 2c6 1 7 11 5 18Z", pivot: [15.84, 20] },
    { d: "M28 20C27 12 29 2 35 2c5 4 2 14-1 19Z", pivot: [32.71, 21] },
  ],
  [
    { d: "M13 20C9 14 10 6 15 3c5 1 7 10 5 17Z", pivot: [15.65, 20] },
    { d: "M28 20C27 12 30 4 35 3c5 4 2 13-1 18Z", pivot: [32.74, 21] },
  ],
  [
    { d: "M14 20C12 13 13 5 17 2c5 3 5 12 3 18Z", pivot: [17.12, 20] },
    { d: "M28 20c0-8 3-16 7-18 5 4 3 14-1 19Z", pivot: [32.98, 21] },
  ],
] as const;

const INNER_EARS = [
  "M15.2 6.5c1.5 2.2 2.2 5.4 2.2 8.3",
  "M34.5 6.5c-1.5 2.2-2.2 5.4-2.2 8.3",
] as const;
const EAR_TILTS = [-5, 5] as const;
const EYE_TRANSFORMS = ["rotate(-12 15.6 28)", "rotate(-12 31.6 28)"] as const;

export const MASCOT_VIEW_BOX = "0 0 48 48";
export const MASCOT_INNER_EAR_WIDTH = 1.4;
export const MASCOT_EYE = { y: 25, width: 3.2, height: 6, rx: 1.6, fill: "#17201F" } as const;
export const MASCOT_NOSE = { cx: 24, cy: 34, r: 1.35 } as const;

export type MascotColor = (typeof PALETTES)[number]["name"];
export type MascotTask = (typeof TASK_PALETTES)[number][0] | "general";

export interface MascotEar {
  d: string;
  inner: string;
  transform: string;
}

export interface MascotEye {
  x: number;
  transform: string;
}

export interface AgentMascotArtwork {
  task: MascotTask;
  color: MascotColor;
  body: string;
  wash: string;
  face: string;
  ears: [MascotEar, MascotEar];
  eyes: [MascotEye, MascotEye];
  hasNose: boolean;
}

export function mascotHash(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 33 + character.charCodeAt(0)) >>> 0;
  return hash;
}

// The web holds an idle ear 1 unit up, 4% shorter and tilted 5 degrees outwards.
function idleEar(side: 0 | 1, variant: number): MascotEar {
  const { d, pivot: [x, y] } = EARS[variant][side];
  return {
    d,
    inner: INNER_EARS[side],
    transform: `translate(${x} ${y - 1}) scale(1 0.96) rotate(${EAR_TILTS[side]}) translate(${-x} ${-y})`,
  };
}

/** Body colour from the task category; face, ears, eyes and nose from a hash of the id. */
export function deriveAgentMascot(id: string, category?: string): AgentMascotArtwork {
  const hash = mascotHash(id);
  const normalized = category?.trim().toLocaleLowerCase() ?? "general";
  const match = TASK_PALETTES.find(([task]) => normalized.includes(task));
  const palette = PALETTES[match ? match[1] : hash % PALETTES.length];
  const face = hash % FACES.length;
  const ears = hash % EARS.length;
  const narrow = face % 2 === 1;

  return {
    task: match ? match[0] : "general",
    color: palette.name,
    body: palette.body,
    wash: palette.wash,
    face: FACES[face],
    ears: [idleEar(0, ears), idleEar(1, ears)],
    eyes: [
      { x: narrow ? 15 : 14, transform: EYE_TRANSFORMS[0] },
      { x: narrow ? 29 : 30, transform: EYE_TRANSFORMS[1] },
    ],
    hasNose: hash % 3 === 0,
  };
}
