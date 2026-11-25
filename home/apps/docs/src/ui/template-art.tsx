/** Small drawings of each template's first page, drawn with the office kit's art marks. */

import type { ReactNode } from "react";
import type { DocsTemplateId } from "./templates";

const W = 114;
const H = 148;

function Page({ children }: { children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} aria-hidden="true">
      <rect className="oui-art__paper" width={W} height={H} />
      {children}
    </svg>
  );
}

function Lines({ y, widths, gap = 7 }: { y: number; widths: number[]; gap?: number }) {
  return (
    <>
      {widths.map((width, index) => (
        <rect key={index} className="oui-art__line" x={14} y={y + index * gap} width={width} height={3} rx={1.5} />
      ))}
    </>
  );
}

function Blank() {
  return (
    <Page>
      <circle className="oui-art__wash" cx={W / 2} cy={H / 2} r={15} />
      <path className="oui-art__stroke" d={`M${W / 2} ${H / 2 - 6}v12M${W / 2 - 6} ${H / 2}h12`} />
    </Page>
  );
}

function Memo() {
  return (
    <Page>
      <rect className="oui-art__ink" x={14} y={16} width={34} height={7} rx={2} />
      {[32, 41, 50, 59].map((y, index) => (
        <g key={y}>
          <rect className="oui-art__ink" x={14} y={y} width={13} height={3} rx={1.5} opacity={0.75} />
          <rect className="oui-art__line" x={31} y={y} width={[34, 28, 24, 46][index]} height={3} rx={1.5} />
        </g>
      ))}
      <path className="oui-art__rule" d="M14 70.5h86" />
      <rect className="oui-art__ink" x={14} y={79} width={24} height={4} rx={2} opacity={0.85} />
      <Lines y={88} widths={[86, 80, 58]} />
      <rect className="oui-art__ink" x={14} y={115} width={28} height={4} rx={2} opacity={0.85} />
      <Lines y={124} widths={[70, 62]} />
    </Page>
  );
}

function MeetingNotes() {
  return (
    <Page>
      <rect className="oui-art__ink" x={14} y={16} width={52} height={7} rx={2} />
      <rect className="oui-art__wash" x={14} y={29} width={40} height={8} rx={4} />
      <rect className="oui-art__ink" x={14} y={46} width={22} height={4} rx={2} opacity={0.85} />
      {[56, 64].map((y, index) => (
        <g key={y}>
          <circle className="oui-art__ink" cx={16} cy={y + 1.5} r={1.8} />
          <rect className="oui-art__line" x={22} y={y} width={[52, 44][index]} height={3} rx={1.5} />
        </g>
      ))}
      <rect className="oui-art__ink" x={14} y={78} width={26} height={4} rx={2} opacity={0.85} />
      <Lines y={87} widths={[84, 66]} />
      <rect className="oui-art__ink" x={14} y={106} width={30} height={4} rx={2} opacity={0.85} />
      <rect className="oui-art__wash" x={14} y={114} width={86} height={7} rx={1} />
      <path className="oui-art__rule" d="M14 121.5h86M14 129.5h86M14 137.5h86M58 114v24M80 114v24" />
    </Page>
  );
}

export function templateArt(id: DocsTemplateId): ReactNode {
  if (id === "memo") return <Memo />;
  if (id === "meeting-notes") return <MeetingNotes />;
  return <Blank />;
}
