"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowRightIcon } from "lucide-react";

export interface TourStep {
  selector: string;
  title: string;
  body: string;
  position?: "top" | "bottom" | "left" | "right";
}

const TOUR_STEPS: TourStep[] = [
  {
    selector: "[data-menu-bar]",
    title: "Menu Bar",
    body: "Access app menus, search with the command palette, and see the time up here.",
    position: "bottom",
  },
  {
    selector: "[data-dock]",
    title: "The Dock",
    body: "Your apps live here. Pin favorites, launch new ones, and switch between open windows.",
    position: "right",
  },
  {
    selector: '[data-testid="dock-chat"]',
    title: "Chat",
    body: "Talk to your AI assistant anytime. Ask questions, get help, or just have a conversation.",
    position: "right",
  },
  {
    selector: '[data-testid="dock-settings"]',
    title: "Settings",
    body: "Customize your workspace — themes, dock position, wallpaper, and more.",
    position: "right",
  },
  {
    selector: '[data-testid="dock-vocal"]',
    title: "Aoede",
    body: "Your voice AI companion. Click to start a voice conversation anytime.",
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
  const overlayRef = useRef<HTMLDivElement>(null);

  const current = TOUR_STEPS[step];

  const measureTarget = useCallback(() => {
    if (!current) return;
    const el = document.querySelector(current.selector);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    setRect({
      top: r.top - pad,
      left: r.left - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    });
  }, [current]);

  // Measure on step change + window resize
  useEffect(() => {
    // Small delay to let the desktop render / settle
    const t = setTimeout(() => {
      measureTarget();
      setVisible(true);
      setTimeout(() => setTooltipVisible(true), 400);
    }, 300);

    const onResize = () => measureTarget();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [step, measureTarget]);

  function goNext() {
    setTooltipVisible(false);
    setTimeout(() => {
      if (step < TOUR_STEPS.length - 1) {
        setStep((s) => s + 1);
      } else {
        setVisible(false);
        setTimeout(onComplete, 500);
      }
    }, 300);
  }

  function skip() {
    setTooltipVisible(false);
    setVisible(false);
    setTimeout(onComplete, 500);
  }

  // Tooltip positioning relative to spotlight
  function getTooltipStyle(): React.CSSProperties {
    if (!rect) return { opacity: 0 };
    const pos = current?.position ?? "right";
    const base: React.CSSProperties = {
      position: "fixed",
      zIndex: 82,
      maxWidth: "18rem",
      transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
      opacity: tooltipVisible ? 1 : 0,
      transform: tooltipVisible ? "translateY(0)" : "translateY(8px)",
    };

    switch (pos) {
      case "bottom":
        return {
          ...base,
          top: rect.top + rect.height + 16,
          left: rect.left + rect.width / 2,
          transform: tooltipVisible
            ? "translateX(-50%) translateY(0)"
            : "translateX(-50%) translateY(8px)",
        };
      case "top":
        return {
          ...base,
          bottom: window.innerHeight - rect.top + 16,
          left: rect.left + rect.width / 2,
          transform: tooltipVisible
            ? "translateX(-50%) translateY(0)"
            : "translateX(-50%) translateY(-8px)",
        };
      case "left":
        return {
          ...base,
          top: rect.top + rect.height / 2,
          right: window.innerWidth - rect.left + 16,
          transform: tooltipVisible
            ? "translateY(-50%) translateX(0)"
            : "translateY(-50%) translateX(-8px)",
        };
      case "right":
      default:
        return {
          ...base,
          top: rect.top + rect.height / 2,
          left: rect.left + rect.width + 16,
          transform: tooltipVisible
            ? "translateY(-50%) translateX(0)"
            : "translateY(-50%) translateX(8px)",
        };
    }
  }

  if (!current) return null;

  return (
    <div
      ref={overlayRef}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        transition: "opacity 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? "auto" : "none",
      }}
    >
      {/* Dark backdrop with spotlight cutout via clip-path */}
      <div
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.55)",
          transition: "clip-path 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
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
        }}
      />

      {/* Spotlight glow ring */}
      {rect && (
        <div
          style={{
            position: "fixed",
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            borderRadius: "12px",
            boxShadow: "0 0 0 3px rgba(196,162,101,0.4), 0 0 30px rgba(196,162,101,0.15)",
            transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
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
            borderRadius: "12px",
            padding: "1.25rem 1.5rem",
            boxShadow: "0 8px 32px rgba(0,0,0,0.12), 0 2px 8px rgba(0,0,0,0.06)",
            border: "1px solid #E8E2D6",
          }}
        >
          <h3
            style={{
              fontFamily: "var(--font-serif), Georgia, serif",
              fontSize: "1.1rem",
              fontWeight: 400,
              color: "#32352E",
              marginBottom: "0.5rem",
              letterSpacing: "-0.01em",
            }}
          >
            {current.title}
          </h3>
          <p
            style={{
              fontFamily: "Arial, Helvetica, sans-serif",
              fontSize: "0.8rem",
              fontWeight: 400,
              color: "#7A7768",
              lineHeight: 1.6,
              marginBottom: "1rem",
            }}
          >
            {current.body}
          </p>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button
              onClick={skip}
              style={{
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: "0.7rem",
                color: "#7A7768",
                opacity: 0.6,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: 0,
                transition: "opacity 0.2s",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.opacity = "1"; }}
              onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.6"; }}
            >
              Skip tour
            </button>

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
                padding: "0.45rem 0.9rem",
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

          {/* Step counter */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              gap: "0.35rem",
              marginTop: "0.75rem",
            }}
          >
            {TOUR_STEPS.map((_, i) => (
              <div
                key={i}
                style={{
                  width: i === step ? "1rem" : "0.35rem",
                  height: "0.35rem",
                  borderRadius: "2px",
                  backgroundColor: i === step ? "#434E3F" : "#D6D0C4",
                  transition: "all 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
