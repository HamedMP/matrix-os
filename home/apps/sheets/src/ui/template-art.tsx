/** Small drawings of each template's first sheet, drawn with the office kit's art marks. */
import type { ReactNode } from "react";
import type { SheetsTemplateId } from "./templates";

const W = 114;
const H = 148;
const ROW = 12;
const TOP = 12;
const HEAD = 10;

function Sheet({ children, cols }: { children: ReactNode; cols: number[] }) {
  const rows = Math.floor((H - TOP) / ROW);
  const grid = [
    ...Array.from({ length: rows + 1 }, (_, index) => `M0 ${TOP + index * ROW + 0.5}H${W}`),
    ...cols.map((x) => `M${x + 0.5} 0V${H}`),
  ].join("");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <rect className="oui-art__paper" width={W} height={H} />
      <rect className="oui-art__soft" width={W} height={TOP} />
      <rect className="oui-art__soft" width={HEAD} height={H} />
      <path className="oui-art__rule" d={grid} />
      {children}
    </svg>
  );
}

const y = (row: number) => TOP + row * ROW;

function Bar({ x, row, width, className = "oui-art__line" }: { x: number; row: number; width: number; className?: string }) {
  return <rect className={className} x={x} y={y(row) + 4.5} width={width} height={3} rx={1.5} />;
}

function Blank() {
  return (
    <Sheet cols={[HEAD, 44, 79]}>
      <rect x={HEAD + 0.5} y={y(0) + 0.5} width={34} height={ROW} className="oui-art__stroke" />
    </Sheet>
  );
}

function Budget() {
  return (
    <Sheet cols={[HEAD, 54, 84]}>
      <Bar x={14} row={0} width={36} className="oui-art__ink" />
      <rect className="oui-art__wash" x={HEAD + 0.5} y={y(2) + 0.5} width={W} height={ROW} />
      <Bar x={14} row={2} width={26} className="oui-art__ink" />
      <Bar x={64} row={2} width={16} className="oui-art__ink" />
      <Bar x={94} row={2} width={16} className="oui-art__ink" />
      {[3, 4, 5, 6, 7, 8, 9].map((row, index) => (
        <g key={row}>
          <Bar x={14} row={row} width={[30, 24, 32, 26, 20, 28, 18][index]} />
          <Bar x={66 + (index % 2) * 2} row={row} width={14 - (index % 2) * 2} />
          {index < 4 && <Bar x={96 + (index % 3) * 2} row={row} width={12 - (index % 3) * 2} />}
        </g>
      ))}
      <path className="oui-art__stroke" d={`M${HEAD} ${y(10) + 0.5}H${W}`} strokeWidth={1.2} />
      <Bar x={14} row={10} width={20} className="oui-art__ink" />
      <Bar x={64} row={10} width={16} className="oui-art__ink" />
      <Bar x={96} row={10} width={12} className="oui-art__ink" />
    </Sheet>
  );
}

function TaskTracker() {
  const pills = ["oui-art__wash", "oui-art__warn", "oui-art__line", "oui-art__wash", "oui-art__line", "oui-art__warn", "oui-art__line", "oui-art__wash"];
  return (
    <Sheet cols={[HEAD, 58, 88]}>
      <rect className="oui-art__wash" x={HEAD + 0.5} y={y(0) + 0.5} width={W} height={ROW} />
      <Bar x={14} row={0} width={20} className="oui-art__ink" />
      <Bar x={62} row={0} width={20} className="oui-art__ink" />
      <Bar x={92} row={0} width={16} className="oui-art__ink" />
      {pills.map((pill, index) => {
        const row = index + 1;
        return (
          <g key={row}>
            <Bar x={14} row={row} width={[38, 30, 34, 26, 36, 28, 32, 24][index]} />
            <rect className={pill} x={62} y={y(row) + 2.5} width={22} height={7} rx={3.5} />
            <Bar x={92} row={row} width={16} />
          </g>
        );
      })}
    </Sheet>
  );
}

export function templateArt(id: SheetsTemplateId): ReactNode {
  if (id === "budget") return <Budget />;
  if (id === "task-tracker") return <TaskTracker />;
  return <Blank />;
}
