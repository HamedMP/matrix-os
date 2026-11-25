/**
 * Reads the app's current colours so the message frame can match them. The
 * frame is a separate document and inherits nothing, so the colours are read
 * as computed values from a probe element and written into the frame's own
 * stylesheet (after `safeFrameTheme` has checked each one).
 */
import { useEffect, useState, type RefObject } from "react";
import { DEFAULT_FRAME_THEME, safeFrameTheme, type FrameTheme } from "./frame-document";

/** Relative luminance (0 to 1) of an `rgb()` / `rgba()` colour, or null when it is not one or is fully transparent. */
export function luminanceOf(color: string): number | null {
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(color.trim());
  if (!match) return null;
  if (match[4] !== undefined && Number.parseFloat(match[4]) === 0) return null;
  const [red, green, blue] = [match[1], match[2], match[3]].map((part) => {
    const channel = Math.min(255, Number.parseFloat(part)) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * Reads the theme from a probe element whose CSS maps the app tokens onto
 * ordinary properties (see `.mx-message-body__probe` in `message-body.css`).
 * Anything that cannot be read falls back to the readable light default.
 */
export function readFrameTheme(probe: Element): FrameTheme {
  const view = probe.ownerDocument.defaultView;
  if (!view) return DEFAULT_FRAME_THEME;
  const style = view.getComputedStyle(probe);
  const background = style.backgroundColor ?? "";
  const luminance = luminanceOf(background);
  // Without a readable background there is nothing to match; keep every colour from the same default set.
  if (luminance === null) return DEFAULT_FRAME_THEME;
  return safeFrameTheme({
    scheme: luminance < 0.4 ? "dark" : "light",
    foreground: style.color ?? "",
    background,
    muted: style.textDecorationColor ?? "",
    border: style.borderTopColor ?? "",
    link: style.outlineColor ?? "",
    fontFamily: style.fontFamily ?? "",
    padding: 0,
  });
}

function sameTheme(a: FrameTheme, b: FrameTheme): boolean {
  return a.scheme === b.scheme && a.foreground === b.foreground && a.background === b.background && a.muted === b.muted
    && a.border === b.border && a.link === b.link && a.fontFamily === b.fontFamily && a.padding === b.padding;
}

/**
 * Calls `onChange` whenever the app's theme may have changed: the shell posts
 * a theme update, the root element's attributes change, or the system colour
 * scheme flips. Returns the function that stops listening.
 */
export function watchThemeChanges(probe: Element, onChange: () => void): () => void {
  const view = probe.ownerDocument.defaultView;
  if (!view) return () => undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The shell rewrites the theme stylesheet after it posts the update, so read on the next task.
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(onChange, 0);
  };
  const onMessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "os:theme-update") schedule();
  };
  view.addEventListener("message", onMessage);
  const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(schedule);
  observer?.observe(probe.ownerDocument.documentElement, { attributes: true });
  const media = typeof view.matchMedia === "function" ? view.matchMedia("(prefers-color-scheme: dark)") : null;
  media?.addEventListener?.("change", schedule);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    view.removeEventListener("message", onMessage);
    observer?.disconnect();
    media?.removeEventListener?.("change", schedule);
  };
}

/** The frame theme for the app's current colours; follows theme changes. */
export function useFrameTheme(probeRef: RefObject<Element | null>): FrameTheme {
  const [theme, setTheme] = useState<FrameTheme>(DEFAULT_FRAME_THEME);

  useEffect(() => {
    const probe = probeRef.current;
    if (!probe) return undefined;
    const update = () => {
      const next = readFrameTheme(probe);
      setTheme((current) => (sameTheme(current, next) ? current : next));
    };
    update();
    return watchThemeChanges(probe, update);
  }, [probeRef]);

  return theme;
}
