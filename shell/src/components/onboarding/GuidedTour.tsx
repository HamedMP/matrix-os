"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon } from "lucide-react";

interface CanvasActions {
  panned: boolean;
  zoomedIn: boolean;
  zoomedOut: boolean;
}

function CanvasProgress({ actions }: { actions: CanvasActions }) {
  const items: { done: boolean; label: ReactNode }[] = [
    { done: actions.panned, label: <>Scroll to pan around</> },
    { done: actions.zoomedIn, label: <>Hold <Kbd>⌘</Kbd> + scroll up to zoom in</> },
    { done: actions.zoomedOut, label: <>Hold <Kbd>⌘</Kbd> + scroll down to zoom out</> },
  ];
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        marginBottom: "1.1rem",
        textAlign: "left",
      }}
    >
      {items.map((item, i) => (
        <div
          key={i}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            fontFamily: "Arial, Helvetica, sans-serif",
            fontSize: "0.8rem",
            fontWeight: 400,
            color: item.done ? "#2F392C" : "#2F392C",
            lineHeight: 1.5,
            transition: "color 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        >
          <div
            style={{
              width: "1.1rem",
              height: "1.1rem",
              borderRadius: "50%",
              border: item.done ? "none" : "1px solid #D6D0C4",
              backgroundColor: item.done ? "#3A7D44" : "transparent",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            {item.done && <CheckIcon style={{ width: "9px", height: "9px", color: "#fff" }} />}
          </div>
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "1.5rem",
        height: "1.5rem",
        padding: "0 0.35rem",
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "0.7rem",
        fontWeight: 600,
        color: "#2F392C",
        backgroundColor: "#F0ECE3",
        border: "1px solid #D6D0C4",
        borderBottom: "2px solid #C8C2B6",
        borderRadius: "5px",
        lineHeight: 1,
      }}
    >
      {children}
    </kbd>
  );
}

type StepInteraction =
  | { type: "none" }
  | { type: "scroll" }
  | { type: "keycombo"; key: string; metaKey?: boolean };

interface TourStep {
  selector: string | null;
  title: string;
  body: ReactNode;
  position?: "top" | "bottom" | "left" | "right" | "center";
  padding?: number;
  interaction?: StepInteraction;
  successMessage?: string;
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: "[data-dock]",
    title: "The Dock",
    body: "Your apps live here. Pin your favorites, launch new ones, and switch between open windows.",
    position: "right",
    padding: 4,
  },
  {
    selector: null,
    title: "Quick Search",
    body: (
      <>
        Try it now — press <Kbd>⌘</Kbd> <Kbd>K</Kbd> to open the command palette.
      </>
    ),
    position: "center",
    interaction: { type: "keycombo", key: "k", metaKey: true },
    successMessage: "Nice! You can search apps and run actions from here anytime.",
  },
  {
    selector: '[data-testid="dock-chat"]',
    title: "Chat",
    body: "Send a message to your AI assistant. It can help you build apps, manage files, and answer questions about your workspace.",
    position: "right",
  },
  {
    selector: '[data-testid="dock-tasks"]',
    title: "Launcher",
    body: "Open the launcher to see all your apps at a glance. Pin favorites and launch anything with one click.",
    position: "right",
  },
  {
    selector: "[data-canvas-area]",
    title: "Your Canvas",
    // Body is rendered dynamically for this step (progress list)
    body: null,
    position: "top",
    padding: 0,
    interaction: { type: "scroll" },
    successMessage: "Well done! Press ⌘0 anytime to fit everything back on screen.",
  },
  {
    selector: '[data-testid="dock-vocal"]',
    title: "Aoede",
    body: "Your voice companion. Click to start a voice conversation — ask anything, hands-free.",
    position: "right",
  },
];

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface GuidedTourProps {
  onComplete: () => void;
}

export function GuidedTour({ onComplete }: GuidedTourProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  const [visible, setVisible] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const [transitioning, setTransitioning] = useState(false);
  const [actionDone, setActionDone] = useState(false);
  const [curtainVisible, setCurtainVisible] = useState(true);
  // When true, the tour steps aside so the real UI (e.g. command palette) is visible
  const [yieldToUI, setYieldToUI] = useState(false);
  // Canvas step: track each action completed
  const [canvasActions, setCanvasActions] = useState({ panned: false, zoomedIn: false, zoomedOut: false });
  const overlayRef = useRef<HTMLDivElement>(null);

  const current = TOUR_STEPS[step];
  const isInteractive = current?.interaction && current.interaction.type !== "none";
  const isCentered = current?.position === "center" && current?.selector === null;
  const isCanvasStep = current?.interaction?.type === "scroll";
  const isKeyComboStep = current?.interaction?.type === "keycombo";

  const measureTarget = useCallback(() => {
    if (!current?.selector) return null;
    const el = document.querySelector(current.selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const pad = current.padding ?? 8;
    return {
      top: r.top - pad,
      left: r.left - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    };
  }, [current]);

  // Initial mount — fade out the white curtain, then reveal tour
  useEffect(() => {
    const t0 = setTimeout(() => setCurtainVisible(false), 100);
    const t = setTimeout(() => {
      const r = measureTarget();
      if (r) setRect(r);
      setVisible(true);
      setTimeout(() => setTooltipVisible(true), 500);
    }, 900);
    return () => { clearTimeout(t0); clearTimeout(t); };
  }, []);

  // Step changes (not initial)
  useEffect(() => {
    if (step === 0) return;
    setActionDone(false);
    setYieldToUI(false);
    if (current?.selector) {
      const r = measureTarget();
      if (r) setRect(r);
    } else {
      setRect(null);
    }
    const t = setTimeout(() => setTooltipVisible(true), 400);
    return () => clearTimeout(t);
  }, [step, measureTarget]);

  // Resize handler
  useEffect(() => {
    const onResize = () => {
      const r = measureTarget();
      if (r) setRect(r);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measureTarget]);

  // Interactive: listen for canvas actions (pan, zoom in, zoom out)
  // Uses a threshold + direction lockout to avoid trackpad momentum/bounce
  // events being registered as the opposite direction.
  useEffect(() => {
    if (!isCanvasStep || actionDone) return;

    // Threshold: ignore tiny momentum events
    const MIN_DELTA = 6;
    // After a zoom direction registers, ignore opposite direction for this long
    const DIRECTION_LOCKOUT_MS = 600;

    let lastZoomDirection: "in" | "out" | null = null;
    let lastZoomTime = 0;

    function onWheel(e: WheelEvent) {
      const absDelta = Math.abs(e.deltaY);
      if (absDelta < MIN_DELTA) return;

      const isZoom = e.ctrlKey || e.metaKey;
      if (!isZoom) {
        setCanvasActions((p) => (p.panned ? p : { ...p, panned: true }));
        return;
      }

      const direction: "in" | "out" = e.deltaY < 0 ? "in" : "out";
      const now = Date.now();

      // If we just registered a zoom in one direction and this is the opposite,
      // it's likely trackpad bounce — ignore it
      if (lastZoomDirection && lastZoomDirection !== direction && now - lastZoomTime < DIRECTION_LOCKOUT_MS) {
        return;
      }

      lastZoomDirection = direction;
      lastZoomTime = now;

      if (direction === "in") {
        setCanvasActions((p) => (p.zoomedIn ? p : { ...p, zoomedIn: true }));
      } else {
        setCanvasActions((p) => (p.zoomedOut ? p : { ...p, zoomedOut: true }));
      }
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [step, actionDone, isCanvasStep]);

  // Mark canvas step done when all 3 actions completed
  useEffect(() => {
    if (!isCanvasStep || actionDone) return;
    if (canvasActions.panned && canvasActions.zoomedIn && canvasActions.zoomedOut) {
      setActionDone(true);
    }
  }, [canvasActions, isCanvasStep, actionDone]);

  // Reset canvas actions when stepping into/out of canvas step
  useEffect(() => {
    if (!isCanvasStep) {
      setCanvasActions({ panned: false, zoomedIn: false, zoomedOut: false });
    }
  }, [step, isCanvasStep]);

  // Interactive: listen for key combo — let the event through to the app
  useEffect(() => {
    if (!isKeyComboStep || actionDone) return;
    const combo = current!.interaction as { type: "keycombo"; key: string; metaKey?: boolean };

    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === combo.key && (!combo.metaKey || e.metaKey || e.ctrlKey)) {
        // Don't block — let the command palette open
        setActionDone(true);
        setYieldToUI(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [step, actionDone, isKeyComboStep, current]);

  // Auto-advance after success message shown (longer for interactive steps)
  useEffect(() => {
    if (!actionDone) return;
    const delay = isInteractive ? 2800 : 3200;
    const t = setTimeout(() => goNext(), delay);
    return () => clearTimeout(t);
  }, [actionDone, isInteractive]);

  function goNext() {
    if (transitioning) return;
    setTransitioning(true);
    setTooltipVisible(false);

    // If we yielded to UI (e.g. command palette), dismiss it before advancing
    if (yieldToUI) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setYieldToUI(false);
    }

    setTimeout(() => {
      if (step < TOUR_STEPS.length - 1) {
        setStep((s) => s + 1);
        setTransitioning(false);
      } else {
        setVisible(false);
        setTimeout(onComplete, 600);
      }
    }, 350);
  }

  function skip() {
    if (yieldToUI) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      setYieldToUI(false);
    }
    setTooltipVisible(false);
    setVisible(false);
    setTimeout(onComplete, 600);
  }

  function getTooltipStyle(): React.CSSProperties {
    const base: React.CSSProperties = {
      position: "fixed",
      // When yielding to UI, tooltip floats above everything at z-100
      zIndex: yieldToUI ? 100 : 82,
      maxWidth: "20rem",
      transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
      opacity: tooltipVisible ? 1 : 0,
    };

    // Centered card (⌘K prompt, before action)
    if (isCentered && !yieldToUI) {
      return {
        ...base,
        top: "50%",
        left: "50%",
        transform: tooltipVisible
          ? "translate(-50%, -50%) scale(1)"
          : "translate(-50%, -50%) scale(0.95)",
      };
    }

    // ⌘K success — float below the command palette
    if (yieldToUI) {
      return {
        ...base,
        bottom: "15%",
        left: "50%",
        transform: tooltipVisible
          ? "translateX(-50%) translateY(0)"
          : "translateX(-50%) translateY(12px)",
      };
    }

    if (!rect) return { ...base, opacity: 0 };
    const pos = current?.position ?? "right";

    // Canvas step — tooltip at the top center of the viewport, above the canvas
    if (isCanvasStep) {
      return {
        ...base,
        top: "4.5rem",
        left: "50%",
        transform: tooltipVisible
          ? "translateX(-50%) translateY(0)"
          : "translateX(-50%) translateY(-12px)",
      };
    }

    switch (pos) {
      case "bottom":
        return {
          ...base,
          top: rect.top + rect.height + 16,
          left: rect.left + rect.width / 2,
          transform: tooltipVisible
            ? "translateX(-50%) translateY(0)"
            : "translateX(-50%) translateY(12px)",
        };
      case "top":
        return {
          ...base,
          bottom: window.innerHeight - rect.top + 16,
          left: rect.left + rect.width / 2,
          transform: tooltipVisible
            ? "translateX(-50%) translateY(0)"
            : "translateX(-50%) translateY(-12px)",
        };
      case "left":
        return {
          ...base,
          top: rect.top + rect.height / 2,
          right: window.innerWidth - rect.left + 16,
          transform: tooltipVisible
            ? "translateY(-50%) translateX(0)"
            : "translateY(-50%) translateX(-12px)",
        };
      case "right":
      default:
        return {
          ...base,
          top: rect.top + rect.height / 2,
          left: rect.left + rect.width + 16,
          transform: tooltipVisible
            ? "translateY(-50%) translateX(0)"
            : "translateY(-50%) translateX(12px)",
        };
    }
  }

  if (!current) return null;

  const showNextButton = !isInteractive || actionDone;
  const hasSpotlight = rect && !isCentered;

  return (
    <>
    {/* Main tour layer */}
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        inset: 0,
        // When yielding to UI (command palette), drop below z-60 so it's visible
        zIndex: yieldToUI ? 55 : 80,
        transition: "opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        opacity: visible ? 1 : 0,
        // Canvas step: let wheel events pass through to the real canvas.
        // Yielding to UI: let clicks reach the command palette.
        pointerEvents: visible && !yieldToUI && !isCanvasStep ? "auto" : "none",
      }}
    >
      {/* Backdrop */}
      {hasSpotlight ? (
        // Box-shadow spotlight with rounded cutout — pointer-events: none
        // so the spotlighted element (canvas, etc.) is fully interactive
        <div
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            borderRadius: "16px",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55), 0 0 0 2px rgba(196,162,101,0.35), 0 0 24px rgba(196,162,101,0.12)",
            transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "none",
            zIndex: 81,
          }}
        />
      ) : (
        // Full dark overlay for centered steps
        <div
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0, 0, 0, 0.6)",
            transition: "opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
            opacity: yieldToUI ? 0 : 1,
            zIndex: 81,
            pointerEvents: "auto",
          }}
        />
      )}

      {/* White curtain — bridges the walkthrough → desktop transition */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "#FFFDF6",
          zIndex: 90,
          transition: "opacity 1.2s cubic-bezier(0.4, 0, 0.2, 1)",
          opacity: curtainVisible ? 1 : 0,
          pointerEvents: "none",
        }}
      />
    </div>

    {/* Tooltip card — always rendered at high z-index, separate from the tour layer
        so it stays visible even when the tour yields to UI */}
    <div style={getTooltipStyle()}>
      <div
        style={{
          backgroundColor: "#FFFDF6",
          borderRadius: "14px",
          padding: "1.25rem 1.5rem",
          boxShadow: "0 12px 40px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.06)",
          border: "1px solid #E8E2D6",
          minWidth: isCentered || yieldToUI ? "18rem" : undefined,
          textAlign: isCentered || yieldToUI || isCanvasStep ? "center" : undefined,
        }}
      >
        {/* Success state */}
        {actionDone && current.successMessage ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.25rem 0",
            }}
          >
            <div
              style={{
                width: "2rem",
                height: "2rem",
                borderRadius: "50%",
                backgroundColor: "#3A7D44",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                animation: "onboard-hello 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards",
              }}
            >
              <CheckIcon style={{ width: "14px", height: "14px", color: "#fff" }} />
            </div>
            <p
              style={{
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: "0.8rem",
                fontWeight: 400,
                color: "#2F392C",
                lineHeight: 1.6,
              }}
            >
              {current.successMessage}
            </p>
          </div>
        ) : (
          <>
            <h3
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: isCentered || isCanvasStep ? "1.25rem" : "1.1rem",
                fontWeight: 400,
                color: "#2F392C",
                marginBottom: "0.5rem",
                letterSpacing: "-0.01em",
              }}
            >
              {current.title}
            </h3>
            {isCanvasStep ? (
              <CanvasProgress actions={canvasActions} />
            ) : (
              <div
                style={{
                  fontFamily: "Arial, Helvetica, sans-serif",
                  fontSize: "0.8rem",
                  fontWeight: 400,
                  color: "#2F392C",
                  lineHeight: 1.7,
                  marginBottom: showNextButton ? "1.1rem" : "0.25rem",
                }}
              >
                {current.body}
              </div>
            )}

            {showNextButton && (
              <div style={{ display: "flex", alignItems: "center", justifyContent: isCentered || isCanvasStep ? "center" : "space-between", gap: "1rem" }}>
                {!isCentered && !isCanvasStep && (
                  <button
                    onClick={skip}
                    style={{
                      fontFamily: "Arial, Helvetica, sans-serif",
                      fontSize: "0.7rem",
                      color: "#2F392C",
                      opacity: 0.5,
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                      transition: "opacity 0.2s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.5"; }}
                  >
                    Skip tour
                  </button>
                )}

                <button
                  onClick={goNext}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontFamily: "Arial, Helvetica, sans-serif",
                    fontSize: "0.8rem",
                    fontWeight: 500,
                    color: "#FFFDF6",
                    backgroundColor: "#434E3F",
                    border: "none",
                    borderRadius: "8px",
                    padding: "0.5rem 1rem",
                    cursor: "pointer",
                    transition: "all 0.2s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = "#374032"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = "#434E3F"; }}
                >
                  {step < TOUR_STEPS.length - 1 ? "Next" : "Done"}
                  {step < TOUR_STEPS.length - 1 && <ArrowRightIcon style={{ width: "12px", height: "12px" }} />}
                </button>
              </div>
            )}
          </>
        )}

        {/* Step dots */}
        {!actionDone && (
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "0.3rem",
              marginTop: "0.85rem",
            }}
          >
            {TOUR_STEPS.map((_, i) => (
              <div
                key={i}
                style={{
                  width: i === step ? "1.1rem" : "0.3rem",
                  height: "0.3rem",
                  borderRadius: "2px",
                  backgroundColor: i === step ? "#434E3F" : "#D6D0C4",
                  transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
}
