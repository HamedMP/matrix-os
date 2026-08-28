"use client";

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
        <span className="text-[8px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">
          x
        </span>
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
        <span className="text-[9px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">
          -
        </span>
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
        <span className="text-[8px] leading-none font-bold text-black/0 transition-colors group-hover/traffic:text-black/60">
          +
        </span>
      </button>
    </div>
  );
}
