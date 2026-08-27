"use client";

import { WindowControlButtons } from "./WindowControlButtons";

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
    <WindowControlButtons
      className={className}
      onClose={onClose}
      onMinimize={onMinimize}
      onMaximize={onFullscreen}
      maximizeLabel="Fullscreen"
    />
  );
}
