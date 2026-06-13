import type { ReactNode } from "react";
import { palette as c, fonts } from "./theme";
import { SectionCard, SectionShell, SectionTitle } from "./primitives";
import { Reveal } from "./Reveal";

const frameBorder = `1px solid ${c.border}`;

function WindowDots() {
  return (
    <span className="flex gap-1" aria-hidden="true">
      {[0, 1, 2].map((dot) => (
        <span key={dot} className="size-1.5 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.22)" }} />
      ))}
    </span>
  );
}

function BrowserMock() {
  return (
    <div className="overflow-hidden rounded-xl" style={{ border: frameBorder, backgroundColor: "#FFFFFF" }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: frameBorder }}>
        <WindowDots />
        <span
          className="mx-auto rounded-md px-2 py-0.5 text-[9px]"
          style={{ backgroundColor: "rgba(67,78,63,0.06)", color: c.subtle, fontFamily: "var(--font-jetbrains), monospace" }}
        >
          app.matrix-os.com
        </span>
      </div>
      <div className="relative h-[120px]" style={{ backgroundColor: c.pageBg }}>
        <div className="absolute left-3 top-3 w-[45%] overflow-hidden rounded-md" style={{ border: frameBorder, backgroundColor: "#FFFFFF" }}>
          <div className="h-3" style={{ borderBottom: frameBorder, backgroundColor: "rgba(67,78,63,0.04)" }} />
          <div className="space-y-1 p-2">
            <div className="h-1.5 w-3/4 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.14)" }} />
            <div className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.10)" }} />
          </div>
        </div>
        <div className="absolute right-3 bottom-3 w-[48%] overflow-hidden rounded-md" style={{ backgroundColor: c.deep }}>
          <div className="space-y-1 p-2">
            <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: "rgba(244,242,230,0.34)" }} />
            <div className="h-1.5 w-1/2 rounded-full" style={{ backgroundColor: "rgba(244,242,230,0.2)" }} />
            <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: "rgba(208,111,37,0.55)" }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function TerminalMock() {
  return (
    <div className="overflow-hidden rounded-xl" style={{ backgroundColor: c.deep, border: frameBorder }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: "1px solid rgba(244,242,230,0.12)" }}>
        <WindowDots />
        <span className="mx-auto text-[9px]" style={{ color: "rgba(244,242,230,0.45)", fontFamily: "var(--font-jetbrains), monospace" }}>
          matrix · cloud shell
        </span>
      </div>
      <div className="h-[120px] space-y-1.5 p-3 text-[10px] leading-relaxed" style={{ fontFamily: "var(--font-jetbrains), monospace" }}>
        <p style={{ color: "#F4F2E6" }}>$ matrix login</p>
        <p style={{ color: "rgba(244,242,230,0.55)" }}>authenticated as @you</p>
        <p style={{ color: "#F4F2E6" }}>$ matrix run -it -- claude</p>
        <p className="flex items-center gap-1.5" style={{ color: "rgba(244,242,230,0.55)" }}>
          <span className="size-1.5 rounded-full" style={{ backgroundColor: c.ember }} />
          session persists after you close the lid
        </p>
      </div>
    </div>
  );
}

function PhoneMock() {
  return (
    <div className="flex h-[152px] items-center justify-center">
      <div className="flex h-[148px] w-[88px] flex-col overflow-hidden rounded-[16px] p-1.5" style={{ border: frameBorder, backgroundColor: "#FFFFFF" }}>
        <div className="flex flex-1 flex-col overflow-hidden rounded-[11px]" style={{ backgroundColor: c.pageBg }}>
          <div className="mx-auto mt-1.5 h-1 w-7 shrink-0 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.18)" }} />
          <div className="flex flex-1 flex-col justify-end space-y-1.5 p-2">
            <div className="ml-auto w-3/4 rounded-md rounded-tr-sm px-1.5 py-1" style={{ backgroundColor: c.forest }}>
              <div className="h-1 w-full rounded-full" style={{ backgroundColor: "rgba(244,242,230,0.5)" }} />
            </div>
            <div className="w-4/5 rounded-md rounded-tl-sm px-1.5 py-1" style={{ backgroundColor: "#FFFFFF", border: frameBorder }}>
              <div className="h-1 w-full rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.16)" }} />
              <div className="mt-1 h-1 w-2/3 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.12)" }} />
            </div>
            <div className="ml-auto w-1/2 rounded-md rounded-tr-sm px-1.5 py-1" style={{ backgroundColor: c.forest }}>
              <div className="h-1 w-full rounded-full" style={{ backgroundColor: "rgba(244,242,230,0.5)" }} />
            </div>
            <div className="mt-0.5 flex h-4 shrink-0 items-center rounded-full px-1.5" style={{ backgroundColor: "#FFFFFF", border: frameBorder }}>
              <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.12)" }} />
              <span className="ml-auto size-2 rounded-full" style={{ backgroundColor: c.ember }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopMock() {
  return (
    <div className="overflow-hidden rounded-xl" style={{ border: frameBorder, backgroundColor: "#FFFFFF" }}>
      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: frameBorder }}>
        <WindowDots />
        <span className="mx-auto text-[9px]" style={{ color: c.subtle }}>
          Matrix for Mac
        </span>
      </div>
      <div className="flex h-[120px] gap-2 p-2.5" style={{ backgroundColor: "rgba(67,78,63,0.03)" }}>
        <div className="w-[26%] space-y-1.5 rounded-md p-2" style={{ backgroundColor: "rgba(67,78,63,0.06)" }}>
          <div className="h-1.5 w-4/5 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.18)" }} />
          <div className="h-1.5 w-3/5 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.12)" }} />
          <div className="h-1.5 w-2/3 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.12)" }} />
        </div>
        {[0, 1, 2].map((column) => (
          <div key={column} className="flex-1 space-y-1.5">
            {Array.from({ length: 3 - (column % 2) }, (_, card) => (
              <div key={card} className="space-y-1 rounded-md p-1.5" style={{ border: frameBorder, backgroundColor: "#FFFFFF" }}>
                <div className="h-1 w-3/4 rounded-full" style={{ backgroundColor: "rgba(67,78,63,0.16)" }} />
                <div className="h-1 w-1/2 rounded-full" style={{ backgroundColor: column === 1 && card === 0 ? "rgba(208,111,37,0.5)" : "rgba(67,78,63,0.1)" }} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

type Surface = {
  name: string;
  status: "Live" | "In progress";
  desc: string;
  Mock: () => ReactNode;
};

const surfaces: readonly Surface[] = [
  {
    name: "Web shell",
    status: "Live",
    desc: "The full visual OS in any browser: windows, terminals, files, previews, and agent sessions.",
    Mock: BrowserMock,
  },
  {
    name: "CLI",
    status: "Live",
    desc: "Attach from any terminal with the Matrix CLI. Sessions survive disconnects, reboots, and closed lids.",
    Mock: TerminalMock,
  },
  {
    name: "Mobile",
    status: "In progress",
    desc: "The web shell already works from your phone. A native app with notifications is in progress.",
    Mock: PhoneMock,
  },
  {
    name: "Desktop app",
    status: "In progress",
    desc: "A native macOS app is in the works. Until then, the web shell is the desktop.",
    Mock: DesktopMock,
  },
] as const;

const statusStyles = {
  Live: { backgroundColor: "#2E3A2A", color: "#F4F2E6" },
  "In progress": { backgroundColor: "rgba(67,78,63,0.08)", color: "#434E3F" },
} as const;

export function SurfacesSection() {
  return (
    <SectionShell id="surfaces" className="pt-16 md:pt-28">
      <Reveal>
        <SectionCard>
          <div className="px-7 pt-9 pb-8 md:px-12 md:pt-12 md:pb-10" style={{ borderBottom: `1px solid ${c.border}` }}>
            <SectionTitle
              title="One computer. Every screen."
              continuation="The work lives in Matrix. Your devices are just viewers."
            />
          </div>
          <div className="grid md:grid-cols-2">
            {surfaces.map((surface, index) => (
              <div
                key={surface.name}
                className={`px-7 py-9 md:px-12 md:py-10 ${
                  ["border-b md:border-r", "border-b", "border-b md:border-b-0 md:border-r", ""][index]
                }`}
                style={{ borderColor: c.border }}
              >
                <div aria-hidden="true">
                  <surface.Mock />
                </div>
                <div className="mt-5 flex items-center gap-2.5">
                  <h3 className="text-[1.0625rem] font-medium" style={{ color: c.deep, fontFamily: fonts.sans }}>
                    {surface.name}
                  </h3>
                  <span className="rounded-md px-2 py-0.5 text-[0.75rem] font-medium" style={statusStyles[surface.status]}>
                    {surface.status}
                  </span>
                </div>
                <p className="mt-2 max-w-[26rem] text-[0.9375rem] leading-[1.6]" style={{ color: c.mutedFg }}>
                  {surface.desc}
                </p>
              </div>
            ))}
          </div>
        </SectionCard>
      </Reveal>
    </SectionShell>
  );
}
