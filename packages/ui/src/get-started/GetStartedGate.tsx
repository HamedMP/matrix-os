import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { productScales } from "@matrix-os/brand/tokens";
import { getStartedSuggestedName, type GetStartedWizardEvent, type GetStartedWizardState } from "@matrix-os/contracts";
import { useGettingStartedAutoOpenSuppression, useGettingStartedBlocker } from "../getting-started-visibility.js";
import { usePublishGetStartedAnswers } from "./answers-context.js";
import type { GetStartedConnect, GetStartedConnector } from "./connect.js";
import { useGetStartedGallery, type GetStartedGalleryPort } from "./gallery.js";
import { GetStartedWizard } from "./GetStartedWizard.js";
import { useGetStarted, type GetStartedPort } from "./use-get-started.js";

/** Returns the element that paints the surface's desktop background (Web: `<body>`, Electron: the background layer). */
export type GetStartedBackdropSource = () => HTMLElement | null;

interface DesktopBackdrop {
  backgroundImage?: string;
  backgroundColor?: string;
}

const TRANSPARENT = new Set(["", "transparent", "rgba(0, 0, 0, 0)"]);

function readDesktopBackdrop(element: HTMLElement | null): DesktopBackdrop | null {
  if (!element) return null;
  const style = window.getComputedStyle(element);
  const image = style.backgroundImage;
  const color = style.backgroundColor;
  const backdrop: DesktopBackdrop = {
    ...(image && image !== "none" ? { backgroundImage: image } : {}),
    ...(!TRANSPARENT.has(color) ? { backgroundColor: color } : {}),
  };
  return backdrop.backgroundImage || backdrop.backgroundColor ? backdrop : null;
}

function sameBackdrop(a: DesktopBackdrop | null, b: DesktopBackdrop | null): boolean {
  return a?.backgroundImage === b?.backgroundImage && a?.backgroundColor === b?.backgroundColor;
}

/**
 * Copies the desktop's own background (wallpaper image or colour) so the wizard can draw it
 * blurred and opaque. It follows later changes: a background layer that mounts after the
 * wizard (Electron) or a wallpaper that finishes loading. Page changes are read at most once
 * per frame, and watching stops as soon as the wizard closes.
 */
function useDesktopBackdrop(source: GetStartedBackdropSource | undefined, active: boolean): CSSProperties | null {
  const [backdrop, setBackdrop] = useState<DesktopBackdrop | null>(null);

  useEffect(() => {
    if (!active || !source || typeof window === "undefined") return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = readDesktopBackdrop(source());
      setBackdrop((previous) => (sameBackdrop(previous, next) ? previous : next));
    };
    update();
    if (typeof MutationObserver === "undefined") return;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(update);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class"] });
    return () => {
      observer.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [source, active]);

  return backdrop;
}

/**
 * While setup is open, modifier shortcuts (Cmd/Ctrl/Alt) stop at the window, so nothing behind the
 * wizard, such as the command palette, opens and takes focus. Typing, Tab and Enter are untouched,
 * and no default action is prevented, so copy and paste keep working.
 */
function useBlockBackgroundShortcuts(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const block = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) event.stopPropagation();
    };
    window.addEventListener("keydown", block, true);
    return () => window.removeEventListener("keydown", block, true);
  }, [active]);
}

/**
 * Offers the account's first name once, when both the wizard and the account have loaded. It only
 * fills a fresh, empty name step: once the owner types (even if they clear it again), a saved name
 * loads, or the wizard resumes on a later step, it never fills.
 */
function usePrefillName(wizard: GetStartedWizardState | null, dispatch: (event: GetStartedWizardEvent) => void, accountName: string | null) {
  const offered = useRef(false);
  const name = getStartedSuggestedName(accountName);
  const loaded = wizard !== null;
  const empty = wizard?.step === "name" && wizard.name === "";
  useEffect(() => {
    if (offered.current || !loaded) return;
    if (!empty) {
      offered.current = true;
      return;
    }
    if (!name) return;
    offered.current = true;
    dispatch({ type: "name", value: name });
  }, [loaded, name, empty, dispatch]);
}

/** Covers the desktop before the wallpaper loads. */
const BACKDROP_FALLBACK: CSSProperties = { backgroundColor: productScales.neutral[800] };

export interface GetStartedGateProps {
  port: GetStartedPort;
  /** The surface's layer for full-window setup overlays: above windows and the dock, below hard gates. */
  zIndex: number;
  /** The onboarding widget: held back until the wizard is finished or not needed. */
  children?: ReactNode;
  /** Supplies app connections for the last screen from the surface's own integration hooks. */
  connector?: GetStartedConnector;
  /** Rendered only while the wizard is open; e.g. Electron's renderer overlay lease above native views. */
  whileActive?: ComponentType;
  /** App Gallery on this computer, for the apps the owner's connections make ready. */
  gallery?: GetStartedGalleryPort;
  /** The element that paints the desktop background; the wizard draws a blurred copy of it. */
  backdropSource?: GetStartedBackdropSource;
  /** The sign-in account's name (Google, GitHub); its first name pre-fills an empty name step once. */
  suggestedName?: string | null;
}

/**
 * Spec 635: shows the Get started wizard once on a new computer, over the blurred wallpaper.
 * The backdrop is opaque, so icons, the dock and windows don't show through.
 * It cannot be closed or minimized; it ends only when the owner finishes or skips it.
 * Any load failure falls back to today's desktop.
 */
export function GetStartedGate({ port, zIndex, children, connector: Connector, whileActive: WhileActive, backdropSource, gallery: galleryPort, suggestedName = null }: GetStartedGateProps) {
  const getStarted = useGetStarted(port);
  const active = getStarted.phase === "active";
  const backdrop = useDesktopBackdrop(backdropSource, active);
  const gallery = useGetStartedGallery(galleryPort, active);
  usePrefillName(getStarted.wizard, getStarted.dispatch, suggestedName);
  useBlockBackgroundShortcuts(active);
  useGettingStartedBlocker(active);
  useGettingStartedAutoOpenSuppression(getStarted.phase !== "done");
  usePublishGetStartedAnswers(getStarted.answers, getStarted.ended);

  if (getStarted.phase === "loading") return null;
  if (getStarted.phase === "done" || !getStarted.wizard) return <>{children}</>;
  const wizard = getStarted.wizard;
  const renderWizard = (connect: GetStartedConnect | null) => (
    <GetStartedWizard
      wizard={wizard}
      submitting={getStarted.submitting}
      error={getStarted.error}
      dispatch={getStarted.dispatch}
      onFinish={getStarted.finish}
      onSkipAll={getStarted.skipAll}
      connect={connect}
      gallery={gallery}
    />
  );
  return (
    <div className="mxo-root mxo-gs ph-no-capture" style={{ zIndex }}>
      {WhileActive ? <WhileActive /> : null}
      <div className="mxo-gs__backdrop" style={BACKDROP_FALLBACK} aria-hidden="true">
        <div className="mxo-gs__backdrop-image" style={backdrop ?? undefined} />
      </div>
      <div className="mxo-gs__scrim" aria-hidden />
      {Connector ? <Connector>{renderWizard}</Connector> : renderWizard(null)}
    </div>
  );
}
