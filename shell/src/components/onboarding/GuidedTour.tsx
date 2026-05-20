"use client";

import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { ArrowRightIcon, CheckIcon } from "lucide-react";

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
        color: "#32352E",
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
    selector: null,
    title: "Your Canvas",
    body: (
      <>
        Try scrolling around — your workspace is an infinite canvas. Hold <Kbd>⌘</Kbd> and scroll to zoom.
      </>
    ),
    position: "center",
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
  const overlayRef = useRef<HTMLDivElement>(null);

  const current = TOUR_STEPS[step];
  const isInteractive = current?.interaction && current.interaction.type !== "none";
  const isCentered = current?.position === "center" || current?.selector === null;

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

  // Initial mount
  useEffect(() => {
    const t = setTimeout(() => {
      const r = measureTarget();
      if (r) setRect(r);
      setVisible(true);
      setTimeout(() => setTooltipVisible(true), 500);
    }, 600);
    return () => clearTimeout(t);
  }, []);

  // Step changes (not initial)
  useEffect(() => {
    if (step === 0) return;
    setActionDone(false);
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

  // Interactive: listen for scroll
  useEffect(() => {
    if (current?.interaction?.type !== "scroll" || actionDone) return;

    function onWheel() {
      setActionDone(true);
    }
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [step, actionDone, current]);

  // Interactive: listen for key combo (capture phase to intercept before app handlers)
  useEffect(() => {
    if (current?.interaction?.type !== "keycombo" || actionDone) return;
    const combo = current.interaction;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key.toLowerCase() === combo.key && (!combo.metaKey || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setActionDone(true);
      }
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [step, actionDone, current]);

  // Auto-advance after success message shown
  useEffect(() => {
    if (!actionDone) return;
    const t = setTimeout(() => goNext(), 2200);
    return () => clearTimeout(t);
  }, [actionDone]);

  function goNext() {
    if (transitioning) return;
    setTransitioning(true);
    setTooltipVisible(false);

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
    setTooltipVisible(false);
    setVisible(false);
    setTimeout(onComplete, 600);
  }

  function getTooltipStyle(): React.CSSProperties {
    const base: React.CSSProperties = {
      position: "fixed",
      zIndex: 82,
      maxWidth: "20rem",
      transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
      opacity: tooltipVisible ? 1 : 0,
    };

    if (isCentered) {
      return {
        ...base,
        top: "50%",
        left: "50%",
        transform: tooltipVisible
          ? "translate(-50%, -50%) scale(1)"
          : "translate(-50%, -50%) scale(0.95)",
      };
    }

    if (!rect) return { ...base, opacity: 0 };
    const pos = current?.position ?? "right";

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

  return (
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        transition: "opacity 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {/* Dark backdrop with spotlight cutout */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: isCentered ? "rgba(0, 0, 0, 0.6)" : "rgba(0, 0, 0, 0.55)",
          transition: "clip-path 0.6s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.6s",
          clipPath: rect
            ? `polygon(
                0% 0%, 0% 100%,
                ${rect.left}px 100%,
                ${rect.left}px ${rect.top}px,
                ${rect.left + rect.width}px ${rect.top}px,
                ${rect.left + rect.width}px ${rect.top + rect.height}px,
                ${rect.left}px ${rect.top + rect.height}px,
                ${rect.left}px 100%,
                100% 100%, 100% 0%
              )`
            : "none",
          zIndex: 81,
          pointerEvents: current?.interaction?.type === "scroll" && !actionDone ? "none" : "auto",
        }}
      />

      {/* Spotlight glow ring */}
      {rect && !isCentered && (
        <div
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            borderRadius: "12px",
            boxShadow: "0 0 0 2px rgba(196,162,101,0.35), 0 0 24px rgba(196,162,101,0.12)",
            transition: "all 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
            pointerEvents: "none",
            zIndex: 82,
          }}
        />
      )}

      {/* Tooltip card */}
      <div style={getTooltipStyle()}>
        <div
          style={{
            backgroundColor: "#FFFDF6",
            borderRadius: "14px",
            padding: "1.25rem 1.5rem",
            boxShadow: "0 12px 40px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.06)",
            border: "1px solid #E8E2D6",
            minWidth: isCentered ? "18rem" : undefined,
            textAlign: isCentered ? "center" : undefined,
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
                  color: "#7A7768",
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
                  fontSize: isCentered ? "1.25rem" : "1.1rem",
                  fontWeight: 400,
                  color: "#32352E",
                  marginBottom: "0.5rem",
                  letterSpacing: "-0.01em",
                }}
              >
                {current.title}
              </h3>
              <div
                style={{
                  fontFamily: "Arial, Helvetica, sans-serif",
                  fontSize: "0.8rem",
                  fontWeight: 400,
                  color: "#7A7768",
                  lineHeight: 1.7,
                  marginBottom: showNextButton ? "1.1rem" : "0.25rem",
                }}
              >
                {current.body}
              </div>

              {showNextButton && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: isCentered ? "center" : "space-between", gap: "1rem" }}>
                  {!isCentered && (
                    <button
                      onClick={skip}
                      style={{
                        fontFamily: "Arial, Helvetica, sans-serif",
                        fontSize: "0.7rem",
                        color: "#7A7768",
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
    </div>
  );
}
