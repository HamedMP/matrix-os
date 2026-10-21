import type { InvokeRequest } from "../../../../shared/ipc-contract";

/** CSS geometry for the trusted native view; Canvas zoom is already in the rect. */
export function readNativeEmbedBounds(host: HTMLElement, visualScale: number): InvokeRequest<"embed:set-bounds">["bounds"] {
  const rect = host.getBoundingClientRect();
  const frame = host.closest<HTMLElement>("[data-os-window]");
  const radius = frame ? Number.parseFloat(getComputedStyle(frame).borderBottomLeftRadius) : 0;
  const cornerRadius = Number.isFinite(radius) && Number.isFinite(visualScale)
    ? Math.max(0, Math.min(64, Math.round(radius * visualScale))) : 0;
  return {
    x: Math.round(rect.left), y: Math.round(rect.top),
    width: Math.round(rect.width), height: Math.round(rect.height),
    ...(cornerRadius > 0 ? { cornerRadius } : {}),
  };
}
