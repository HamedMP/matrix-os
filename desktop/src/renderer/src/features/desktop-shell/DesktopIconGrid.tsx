import { useEffect, useRef, useState } from "react";
import type { TabKind } from "../../stores/tabs";
import SurfaceIcon, { surfaceIconTab } from "./SurfaceIcon";

export interface DesktopDestination {
  kind: TabKind;
  label: string;
  open: () => void;
}

export default function DesktopIconGrid({ destinations }: { destinations: DesktopDestination[] }) {
  const [selectedKind, setSelectedKind] = useState<TabKind | null>(null);
  const layerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const clearSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || layerRef.current?.contains(target)) return;
      setSelectedKind(null);
    };
    document.addEventListener("pointerdown", clearSelection);
    return () => document.removeEventListener("pointerdown", clearSelection);
  }, []);

  return (
    <nav
      ref={layerRef}
      aria-label="Desktop apps"
      className="absolute left-5 top-5 grid grid-cols-2 gap-x-3 gap-y-4"
      style={{ zIndex: 1 }}
    >
      {destinations.map((destination) => {
        const selected = selectedKind === destination.kind;
        return (
          <button
            key={destination.kind}
            type="button"
            aria-label={destination.label}
            data-selected={selected || undefined}
            className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] data-[selected]:bg-[var(--bg-selected)]"
            onClick={() => setSelectedKind(destination.kind)}
            onDoubleClick={destination.open}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                destination.open();
              } else if (event.key === "Escape") {
                setSelectedKind(null);
              }
            }}
          >
            <span
              className="flex size-12 items-center justify-center rounded-[14px] border bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-2)] transition-transform duration-150 group-hover:-translate-y-0.5"
              style={{ borderColor: "var(--border-subtle)" }}
            >
              <SurfaceIcon tab={surfaceIconTab(destination.kind, destination.label)} size={24} />
            </span>
            <span
              className="max-w-full truncate rounded px-1 text-[12px] font-medium"
              style={{ color: "var(--text-primary)", textShadow: "0 1px 0 var(--bg-sunken)" }}
            >
              {destination.label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
