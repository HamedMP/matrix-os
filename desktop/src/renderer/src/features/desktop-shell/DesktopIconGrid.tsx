import { useEffect, useRef, useState } from "react";
import DesktopAppIcon from "./DesktopAppIcon";
import type { DesktopAppConfig } from "./desktop-apps";
import { DESKTOP_Z_INDEX } from "../../design/layering";
import type { DesktopIconPlacement } from "../../stores/desktop-icons";

export interface DesktopDestination extends Omit<DesktopAppConfig, "id"> {
  id: string;
  iconUrl?: string;
  open: () => void;
}

export default function DesktopIconGrid({
  destinations,
  placements,
  onMove,
  onRemove,
}: {
  destinations: DesktopDestination[];
  placements: DesktopIconPlacement[];
  onMove: (path: string, x: number, y: number) => void;
  onRemove: (path: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ path: string; name: string; x: number; y: number } | null>(null);
  const layerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const clearSelection = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || layerRef.current?.contains(target)) return;
      setSelectedId(null);
      setMenu(null);
    };
    document.addEventListener("pointerdown", clearSelection);
    return () => document.removeEventListener("pointerdown", clearSelection);
  }, []);

  return (
    <nav
      ref={layerRef}
      aria-label="Desktop apps"
      className="pointer-events-none absolute inset-0"
      style={{ zIndex: DESKTOP_Z_INDEX.nativeDesktopIcons }}
    >
      {placements.map((placement) => {
        const destination = destinations.find((candidate) => candidate.path === placement.path);
        if (!destination) return null;
        const selected = selectedId === destination.id;
        return (
          <button
            key={destination.id}
            type="button"
            aria-label={destination.name}
            data-selected={selected || undefined}
            className="pointer-events-auto group absolute flex w-[76px] touch-none flex-col items-center gap-1.5 rounded-xl px-1 py-1.5 outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] data-[selected]:bg-[var(--bg-selected)]"
            style={{ left: placement.x, top: placement.y }}
            onClick={() => setSelectedId(destination.id)}
            onDoubleClick={destination.open}
            onContextMenu={(event) => {
              event.preventDefault();
              setMenu({ path: placement.path, name: destination.name, x: event.clientX, y: event.clientY });
            }}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const startX = event.clientX;
              const startY = event.clientY;
              const pointerId = event.pointerId;
              event.currentTarget.setPointerCapture?.(pointerId);
              const target = event.currentTarget;
              const move = (moveEvent: PointerEvent) => {
                target.style.left = `${Math.max(0, placement.x + moveEvent.clientX - startX)}px`;
                target.style.top = `${Math.max(0, placement.y + moveEvent.clientY - startY)}px`;
              };
              const up = (upEvent: PointerEvent) => {
                target.removeEventListener("pointermove", move);
                target.removeEventListener("pointerup", up);
                const dx = upEvent.clientX - startX;
                const dy = upEvent.clientY - startY;
                if (Math.abs(dx) + Math.abs(dy) > 3) {
                  onMove(placement.path, Math.max(0, placement.x + dx), Math.max(0, placement.y + dy));
                }
              };
              target.addEventListener("pointermove", move);
              target.addEventListener("pointerup", up);
            }}
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
              icon={destination.iconUrl
                ? <img src={destination.iconUrl} alt="" className="size-full object-cover" draggable={false} />
                : <destination.icon size={24} aria-hidden="true" />}
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
      {menu ? (
        <div
          role="menu"
          data-launchpad-interactive
          className="pointer-events-auto fixed min-w-48 rounded-xl border p-1 shadow-[var(--shadow-3)]"
          style={{ left: menu.x, top: menu.y, zIndex: DESKTOP_Z_INDEX.nativeDesktopLaunchpad, background: "var(--bg-surface)" }}
        >
          <button
            type="button"
            role="menuitem"
            className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-[var(--bg-hover)]"
            onClick={() => {
              onRemove(menu.path);
              setMenu(null);
            }}
          >
            Remove {menu.name} from Desktop
          </button>
        </div>
      ) : null}
    </nav>
  );
}
