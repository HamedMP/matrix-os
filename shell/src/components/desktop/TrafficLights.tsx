import { WindowControlButtons } from "../window/WindowControlButtons";

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
    <WindowControlButtons
      className="mr-2"
      onClose={onClose}
      onMinimize={onMinimize}
      onMaximize={onFullscreen}
      maximizeLabel="Fullscreen"
    />
  );
}
