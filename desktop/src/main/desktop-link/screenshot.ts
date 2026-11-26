// One screenshot of this desktop's screen for a linked computer (spec 2716),
// on macOS, Linux and Windows, through Electron's desktopCapturer in the main
// process. macOS lets an app see other windows only once the person allows
// Screen Recording for it (System Settings > Privacy & Security > Screen &
// System Audio Recording > Matrix OS); until then this answers "permission"
// and captures nothing. Where the session cannot be captured at all (some
// Linux Wayland sessions without a portal), it answers "unavailable". The
// image is the primary screen, at most 1600 px on its long side, as JPEG.
import { DESKTOP_LINK_CAPTURE_MAX_BYTES } from "@matrix-os/contracts/desktop-link";
import type { DesktopScreenshotResult } from "./service";

const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_SIDE = 1600;
const JPEG_QUALITY = 80;

/** The parts of Electron's NativeImage this uses. */
export interface ScreenImage { isEmpty(): boolean; toJPEG(quality: number): Buffer }
export interface ScreenSource { display_id: string; thumbnail: ScreenImage }

export interface ScreenshotDeps {
  platform: NodeJS.Platform;
  /** `systemPreferences.getMediaAccessStatus("screen")`; asked on macOS only. */
  screenAccess(): string;
  /** `desktopCapturer.getSources`. */
  getSources(options: { types: ["screen"]; thumbnailSize: { width: number; height: number } }): Promise<ScreenSource[]>;
  /** The primary display: its id and size in device pixels. */
  primaryDisplay(): { id: number; width: number; height: number };
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("screen capture timed out")), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export function createDesktopScreenshot(deps: ScreenshotDeps): () => Promise<DesktopScreenshotResult> {
  return async () => {
    if (deps.platform === "darwin" && deps.screenAccess() !== "granted") return { ok: false, reason: "permission" };
    const display = deps.primaryDisplay();
    const scale = Math.min(1, MAX_SIDE / Math.max(display.width, display.height, 1));
    const thumbnailSize = { width: Math.max(1, Math.round(display.width * scale)), height: Math.max(1, Math.round(display.height * scale)) };
    let sources: ScreenSource[];
    try {
      sources = await withTimeout(deps.getSources({ types: ["screen"], thumbnailSize }), deps.timeoutMs ?? CAPTURE_TIMEOUT_MS);
    } catch (error: unknown) {
      console.warn("[desktop-link] screen capture failed:", error instanceof Error ? error.name : "UnknownError");
      return { ok: false, reason: deps.platform === "linux" ? "unavailable" : "failed" };
    }
    const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
    // No source or an empty frame: the session gave nothing to capture (Wayland without a portal).
    if (!source || source.thumbnail.isEmpty()) return { ok: false, reason: deps.platform === "linux" ? "unavailable" : "failed" };
    const image = source.thumbnail.toJPEG(JPEG_QUALITY);
    if (image.length === 0) return { ok: false, reason: "failed" };
    if (image.length > DESKTOP_LINK_CAPTURE_MAX_BYTES) return { ok: false, reason: "too_large" };
    return { ok: true, image };
  };
}
