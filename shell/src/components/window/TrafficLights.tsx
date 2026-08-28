"use client";

import { ArrowExpand01, Minus, X } from "@/lib/hugeicons";

interface TrafficLightsProps {
  className?: string;
  onClose: () => void;
  onMinimize: () => void;
  onFullscreen?: () => void;
}

export function TrafficLights({
  className,
  onClose,
  onMinimize,
  onFullscreen,
}: TrafficLightsProps) {
  return (
    <div
      className={`group/traffic flex items-center gap-1.5 ${className ?? ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="flex size-3 items-center justify-center rounded-full bg-[#ff5f57] transition-colors hover:brightness-90"
        aria-label="Close"
      >
        <X aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
      </button>
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onMinimize();
        }}
        className="flex size-3 items-center justify-center rounded-full bg-[#febc2e] transition-colors hover:brightness-90"
        aria-label="Minimize"
      >
        <Minus aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
      </button>
      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onFullscreen?.();
        }}
        className="flex size-3 items-center justify-center rounded-full bg-[#28c840] transition-colors hover:brightness-90"
        aria-label="Fullscreen"
      >
        <ArrowExpand01 aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/0 transition-colors group-hover/traffic:text-black/60 group-focus-within/traffic:text-black/60" />
      </button>
    </div>
  );
}
