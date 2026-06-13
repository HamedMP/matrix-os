const ISO_GRID = 4;
const ISO_T = 13;
const ISO_TH = 7;
const ISO_ORIGIN_X = 85;
const ISO_ORIGIN_Y = 48;

type CubeTone = { top: string; right: string; left: string };

const forestTone: CubeTone = {
  top: "#EFEEE2",
  right: "rgba(67, 78, 63, 0.55)",
  left: "rgba(50, 53, 46, 0.72)",
};

const emberTone: CubeTone = {
  top: "#F4DCC4",
  right: "#D06F25",
  left: "#A85A1E",
};

function isoHash(i: number, j: number, seed: number): number {
  return (i * 11 + j * 17 + seed * 29 + i * j * 7) % 23;
}

function IsoCube({ i, j, seed }: { i: number; j: number; seed: number }) {
  const hash = isoHash(i, j, seed);
  if (hash % 5 === 0) return null;

  const cx = ISO_ORIGIN_X + (i - j) * ISO_T;
  const ground = ISO_ORIGIN_Y + (i + j) * ISO_TH;
  const height = 6 + (hash % 4) * 6;
  const tone = hash % 7 === 1 ? emberTone : forestTone;
  const topY = ground - height;

  return (
    <g>
      <polygon
        points={`${cx},${topY + ISO_TH} ${cx + ISO_T},${topY} ${cx + ISO_T},${ground} ${cx},${ground + ISO_TH}`}
        fill={tone.right}
      />
      <polygon
        points={`${cx - ISO_T},${topY} ${cx},${topY + ISO_TH} ${cx},${ground + ISO_TH} ${cx - ISO_T},${ground}`}
        fill={tone.left}
      />
      <polygon
        points={`${cx},${topY - ISO_TH} ${cx + ISO_T},${topY} ${cx},${topY + ISO_TH} ${cx - ISO_T},${topY}`}
        fill={tone.top}
      />
    </g>
  );
}

export function IsoArt({ seed, className = "h-auto w-full max-w-[180px]" }: { seed: number; className?: string }) {
  const cells: Array<{ i: number; j: number }> = [];
  for (let depth = 0; depth <= (ISO_GRID - 1) * 2; depth++) {
    for (let i = 0; i < ISO_GRID; i++) {
      const j = depth - i;
      if (j >= 0 && j < ISO_GRID) cells.push({ i, j });
    }
  }
  return (
    <svg viewBox="0 0 170 110" className={className} aria-hidden="true">
      {cells.map(({ i, j }) => (
        <IsoCube key={`${i}-${j}`} i={i} j={j} seed={seed} />
      ))}
    </svg>
  );
}
