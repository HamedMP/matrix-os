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
    <div className="group/traffic flex items-center gap-1.5 mr-2">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="size-3 rounded-full bg-[#ff5f57] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Close"
      >
        <span className="text-[8px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          x
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onMinimize();
        }}
        className="size-3 rounded-full bg-[#febc2e] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Minimize"
      >
        <span className="text-[9px] leading-none font-bold text-black/0 group-hover/traffic:text-black/60 transition-colors">
          -
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onFullscreen?.();
        }}
        className="size-3 rounded-full bg-[#28c840] flex items-center justify-center hover:brightness-90 transition-colors"
        aria-label="Fullscreen"
      />
    </div>
  );
}
