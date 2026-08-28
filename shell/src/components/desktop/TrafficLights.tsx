import { ArrowExpand01, Minus, X } from "@/lib/hugeicons";

export function TrafficLights({
  onClose,
  onMinimize,
  onFullscreen,
}: {
  onClose: () => void;
  onMinimize: () => void;
  onFullscreen?: () => void;
}) {
  return (
    <div className="group/traffic mr-2 flex items-center gap-1.5">
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
        <X aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/65" />
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
        <Minus aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/65" />
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
        <ArrowExpand01 aria-hidden="true" size={8} strokeWidth={1.8} className="text-black/65" />
      </button>
    </div>
  );
}
