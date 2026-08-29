import { useEffect, useRef, useState } from "react";
import DesktopAppIcon from "./DesktopAppIcon";
import type { DesktopAppConfig } from "./desktop-apps";
import { DESKTOP_Z_INDEX } from "../../design/layering";

export interface DesktopDestination extends DesktopAppConfig {
  open: () => void;
}

export default function DesktopIconGrid({ destinations }: { destinations: DesktopDestination[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const layerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const clearSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || layerRef.current?.contains(target)) return;
      setSelectedId(null);
    };
    document.addEventListener("pointerdown", clearSelection);
    return () => document.removeEventListener("pointerdown", clearSelection);
  }, []);

  return (
    <nav
      ref={layerRef}
      aria-label="Desktop apps"
      className="absolute left-5 top-5 grid grid-cols-2 gap-x-3 gap-y-4"
      style={{ zIndex: DESKTOP_Z_INDEX.nativeDesktopIcons }}
    >
      {destinations.map((destination) => {
        const selected = selectedId === destination.id;
        return (
          <button
            key={destination.id}
            type="button"
            aria-label={destination.name}
            data-selected={selected || undefined}
            className="group flex w-[76px] flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] data-[selected]:bg-[var(--bg-selected)]"
            onClick={() => setSelectedId(destination.id)}
            onDoubleClick={destination.open}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                destination.open();
              } else if (event.key === "Escape") {
                setSelectedId(null);
              }
            }}
          >
            <DesktopAppIcon
              name={destination.name}
              icon={<destination.icon size={24} aria-hidden="true" />}
              color={destination.color ?? "var(--bg-surface)"}
              iconColor={destination.iconColor ?? "var(--accent)"}
              className="relative size-12 rounded-[14px] border shadow-[var(--shadow-2)] transition-transform duration-150 group-hover:-translate-y-0.5"
              style={{ borderColor: "var(--border-subtle)" }}
            />
            <span
              data-desktop-icon-label
              className="max-w-full truncate text-[12px] font-medium"
              style={{
                color: "#fff",
                textShadow: "0 1px 2px rgba(0, 0, 0, 0.95), 0 0 3px rgba(0, 0, 0, 0.8)",
              }}
            >
              {destination.name}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
