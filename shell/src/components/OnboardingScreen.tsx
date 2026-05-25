"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { MicPermissionDialog } from "./MicPermissionDialog";
import { ArrowRightIcon } from "lucide-react";

const MANUAL_STEPS = [
  {
    heading: "This is Matrix OS",
    body: "A personal operating system that lives in the cloud. Your files, your apps, your AI — all in one place, accessible from anywhere.",
  },
  {
    heading: "Your workspace, your way",
    body: "Matrix OS learns how you work. It sets up your environment based on what you care about — your tools, your workflows, your preferences.",
  },
  {
    heading: "Bring your own agents.",
    body: "The system is model agnostic, so you can run your local agents or use any cloud provider.",
  },
];

type Phase = "idle" | "lifting" | "ascending" | "whiteout" | "dimming" | "black" | "revealing";

interface OnboardingScreenProps {
  onComplete: () => void;
  onOpenTerminal: () => void;
  onStartTour?: () => void;
}

export function OnboardingScreen({ onComplete, onOpenTerminal, onStartTour }: OnboardingScreenProps) {
  const ob = useOnboarding();
  const mic = useMicPermission();
  const [phase, setPhase] = useState<Phase>("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualStep, setManualStep] = useState(0);
  const [showModePicker, setShowModePicker] = useState(false);
  const [splitVisible, setSplitVisible] = useState(false);
  const [continueExiting, setContinueExiting] = useState(false);
  const [entranceStage, setEntranceStage] = useState<"hidden" | "center" | "settled">("hidden");
  const [headingVisible, setHeadingVisible] = useState(false);
  const [bodyVisible, setBodyVisible] = useState(false);
  const [buttonVisible, setButtonVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const ambientRef = useRef<HTMLAudioElement | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const subtitle = ob.currentSubtitle;

  useEffect(() => {
    if (ob.alreadyComplete) {
      onComplete();
    }
  }, [ob.alreadyComplete, onComplete]);

  useEffect(() => {
    if (ob.alreadyComplete) return;
    // A successful voice-mode completion ("done" stage) now routes through
    // the guided tour just like manual mode, so both paths end with the
    // dashboard tour + welcome overlay. Skip buttons still call onComplete
    // directly to bypass the tour.
    const onFinishedSuccessfully = onStartTour ?? onComplete;
    if (ob.stage === "done" && gainNodeRef.current && audioCtxRef.current) {
      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2);
      setTimeout(onFinishedSuccessfully, 2000);
    } else if (ob.stage === "done") {
      setTimeout(onFinishedSuccessfully, 800);
    }
  }, [ob.stage, ob.alreadyComplete, onComplete, onStartTour]);

  useEffect(() => {
    return () => {
      ambientRef.current?.pause();
      audioCtxRef.current?.close();
    };
  }, []);

  // Entrance choreography, three beats:
  //   "hidden"  → everything invisible, logo pre-positioned at viewport center.
  //   "center"  → logo fades in big and centered, alone. Holds here a moment.
  //   "settled" → logo eases into its lockup spot while the title and Continue
  //               button fade in beneath it.
  // Staged so the centered logo gets a real beat on screen before the rest
  // arrives. The first flip is one tick after mount so the "hidden" styles
  // paint first and the fade-in actually transitions.
  useEffect(() => {
    const t1 = setTimeout(() => setEntranceStage("center"), 90);
    const t2 = setTimeout(() => setEntranceStage("settled"), 90 + 1900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  // Staggered reveal for manual walkthrough steps
  useEffect(() => {
    if (!manualMode || phase !== "revealing") return;

    setHeadingVisible(false);
    setBodyVisible(false);
    setButtonVisible(false);
    setExiting(false);

    // First step: long pause after the panel rises, then slow staggered reveals.
    // Subsequent steps: tighter timing since we're already in the flow.
    const isFirstStep = manualStep === 0;
    const headingDelay = isFirstStep ? 1400 : 250;
    const bodyDelay = isFirstStep ? 3400 : 1500;
    const buttonDelay = isFirstStep ? 5000 : 2700;

    const t0 = setTimeout(() => setHeadingVisible(true), headingDelay);
    const t1 = setTimeout(() => setBodyVisible(true), bodyDelay);
    const t2 = setTimeout(() => setButtonVisible(true), buttonDelay);

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [manualMode, phase, manualStep]);

  function startAmbientAudio() {
    const audio = new Audio("/onboarding-ambient.wav");
    audio.loop = true;
    ambientRef.current = audio;

    const ctx = new AudioContext();
    audioCtxRef.current = ctx;
    const source = ctx.createMediaElementSource(audio);
    const gain = ctx.createGain();
    gainNodeRef.current = gain;

    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.22, ctx.currentTime + 5);

    source.connect(gain);
    gain.connect(ctx.destination);
    audio.play().catch((err: unknown) => {
      console.warn("[onboarding] ambient audio playback failed", err);
    });
  }

  function handleStartVoice() {
    setPhase("lifting");
    setTimeout(() => {
      setPhase("dimming");
      setTimeout(() => {
        setPhase("black");
        startAmbientAudio();
        ob.start(true);
        setTimeout(() => setPhase("revealing"), 500);
      }, 1400);
    }, 600);
  }

  // Continue → split reveal, choreographed in two beats:
  //   1. The Continue button fades/drifts away and the logo lockup begins
  //      settling upward (continueExiting flips immediately on click).
  //   2. ~520ms later, once the button has cleared, the split mounts and the
  //      two panels + divider animate in on the next frame.
  // State-driven inline transitions (not CSS keyframes) so timing is fully
  // controllable here and doesn't depend on a CSS recompile.
  function handleContinue() {
    setContinueExiting(true);
    setTimeout(() => {
      setShowModePicker(true);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setSplitVisible(true));
      });
    }, 520);
  }

  // iOS-style "page rise" transition: panel slides up from below, revealing the walkthrough
  function handleStartManual() {
    setManualMode(true);
    setPhase("ascending"); // landing exits, panel rises (1.1s total)
    setTimeout(() => {
      setPhase("revealing"); // panel in place, walkthrough content reveals
    }, 1100);
  }

  function handleManualNext() {
    // Trigger symmetric fade-out (mirror of fade-in) — button leaves first,
    // body second, heading last. Each element runs onboard-text-fall.
    setExiting(true);

    setTimeout(() => {
      if (manualStep < MANUAL_STEPS.length - 1) {
        setManualStep((s) => s + 1);
      } else if (onStartTour) {
        onStartTour();
      } else {
        setManualMode(false);
        ob.start(false);
      }
    }, 1100);
  }

  const handleVoiceMode = useCallback(async () => {
    if (mic.state === "granted") {
      handleStartVoice();
      return;
    }
    if (mic.state === "denied") {
      setShowMicDialog(true);
      return;
    }
    const granted = await mic.requestAccess();
    if (granted) handleStartVoice();
    else setShowMicDialog(true);
  }, [mic.state, mic.requestAccess]);

  const handleMicAllow = useCallback(async () => {
    const granted = await mic.requestAccess();
    setShowMicDialog(false);
    if (granted) {
      handleStartVoice();
    }
  }, [mic.requestAccess]);

  const isConversing = ob.stage === "greeting" || ob.stage === "interview" || ob.stage === "connecting";

  if (ob.alreadyComplete) {
    return null;
  }

  const isTransitioning = phase !== "idle";
  const isPreReveal = phase === "lifting" || phase === "dimming" || phase === "black" || phase === "ascending" || phase === "whiteout";

  return (
    <>
    {/* Landing screen — stays mounted as overlay during ascension/transition */}
    {phase !== "revealing" && (
      <div className="fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: "var(--background)", overflow: "hidden" }}>
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        <div
          className="flex-1 flex flex-col items-center justify-center"
          style={{
            position: "relative",
            zIndex: 2,
            gap: showModePicker ? "2.5rem" : "2.5rem",
            transition: "gap 1s cubic-bezier(0.16, 1, 0.3, 1)",
            ...(manualMode && (phase === "ascending" || phase === "whiteout")
              ? { animation: "onboard-landing-exit 0.8s cubic-bezier(0.22, 1, 0.36, 1) forwards" }
              : {}),
          }}
        >
          {/* Logo + title lockup — begins settling upward the moment Continue is
              pressed (continueExiting), so the motion leads the split reveal. */}
          <div
            className="flex flex-col items-center"
            style={{
              gap: "1.6rem",
              transition: "transform 1.6s cubic-bezier(0.16, 1, 0.3, 1)",
              transform: continueExiting ? "scale(0.78) translateY(-12px)" : "scale(1) translateY(0)",
            }}
          >
            {/* Rabbit logo — CSS mask with shimmer gradient */}
            <div
              style={{
                width: "120px",
                height: "155px",
                WebkitMaskImage: "url('/matrix-logo.svg')",
                WebkitMaskRepeat: "no-repeat",
                WebkitMaskSize: "contain",
                WebkitMaskPosition: "center",
                maskImage: "url('/matrix-logo.svg')",
                maskRepeat: "no-repeat",
                maskSize: "contain",
                maskPosition: "center",
                backgroundImage:
                  phase === "ascending" || phase === "whiteout"
                    ? "linear-gradient(90deg, #D9B673 0%, #E8C988 50%, #D9B673 100%)"
                    : isTransitioning
                      ? "linear-gradient(90deg, #C4A265 0%, #C4A265 100%)"
                      : "linear-gradient(90deg, #2F392C 0%, #2F392C 25%, #C4A265 50%, #2F392C 75%, #2F392C 100%)",
                backgroundSize: "300% 100%",
                animation: !isTransitioning
                  ? "onboard-shimmer 8s ease-in-out infinite, onboard-glow 8s ease-in-out infinite"
                  : "none",
                transition: "opacity 1s cubic-bezier(0.16, 1, 0.3, 1), transform 1.7s cubic-bezier(0.16, 1, 0.3, 1)",
                transform: entranceStage !== "settled"
                  ? "translateY(30vh) scale(1.6)"
                  : isPreReveal
                    ? "translateY(-24px) scale(1.06)"
                    : "translateY(0) scale(1)",
                opacity: entranceStage === "hidden" ? 0 : phase === "black" ? 0 : 1,
              }}
            />

            {/* Title — "Matrix OS" with shimmer */}
            <h1
              className="cursor-default select-none"
              style={{
                fontFamily: "var(--font-orbitron), sans-serif",
                fontSize: "clamp(1.6rem, 4vw, 2.4rem)",
                fontWeight: 500,
                letterSpacing: "0.08em",
                textTransform: "uppercase" as const,
                lineHeight: 1.1,
                margin: 0,
                transition:
                  "opacity 1.1s cubic-bezier(0.16, 1, 0.3, 1) 0.35s, transform 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.35s",
                transform: entranceStage !== "settled"
                  ? "translateY(16px) scale(0.98)"
                  : isPreReveal
                    ? "translateY(-24px) scale(1.06)"
                    : "translateY(0) scale(1)",
                opacity: entranceStage !== "settled" ? 0 : phase === "black" ? 0 : 1,
              }}
            >
              <span
                style={{
                  backgroundClip: "text",
                  WebkitBackgroundClip: "text",
                  color: "transparent",
                  backgroundImage:
                    phase === "ascending" || phase === "whiteout"
                      ? "linear-gradient(90deg, #D9B673 0%, #E8C988 50%, #D9B673 100%)"
                      : isTransitioning
                        ? "linear-gradient(90deg, #C4A265 0%, #C4A265 100%)"
                        : "linear-gradient(90deg, #2F392C 0%, #2F392C 25%, #C4A265 50%, #2F392C 75%, #2F392C 100%)",
                  backgroundSize: "300% 100%",
                  animation: !isTransitioning
                    ? "onboard-shimmer 8s ease-in-out infinite, onboard-glow 8s ease-in-out infinite"
                    : "none",
                  transition: "background-image 1.6s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                Matrix OS
              </span>
            </h1>
          </div>

          {/* Choice region — the split grid is ALWAYS mounted so it reserves its
              layout height; its panels simply stay invisible (opacity 0) until
              the reveal. The Continue button is overlaid absolutely on top in
              phase 1. Because the region's size never changes when we swap
              button → split, the logo above never jumps. */}
          <div
            style={{
              position: "relative",
              width: "100%",
              display: "flex",
              justifyContent: "center",
              opacity: entranceStage === "settled" ? 1 : 0,
              transition: "opacity 1.2s cubic-bezier(0.16, 1, 0.3, 1) 0.55s",
            }}
          >
            {/* Continue overlay (phase 1) */}
            {!showModePicker && (
              <button
                onClick={handleContinue}
                disabled={isTransitioning}
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  padding: "0.55rem 1.8rem",
                  fontFamily: "var(--font-inter), system-ui, sans-serif",
                  fontSize: "0.85rem",
                  fontWeight: 500,
                  letterSpacing: "0.02em",
                  color: "#2F392C",
                  background: "none",
                  border: "1px solid rgba(47, 57, 44, 0.25)",
                  borderRadius: "999px",
                  cursor: continueExiting ? "default" : "pointer",
                  pointerEvents: continueExiting ? "none" : "auto",
                  opacity: continueExiting || isTransitioning ? 0 : 1,
                  transform: continueExiting
                    ? "translate(-50%, calc(-50% + 10px)) scale(0.94)"
                    : "translate(-50%, -50%) scale(1)",
                  transition:
                    "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.45s, color 0.45s",
                }}
                onMouseEnter={(e) => {
                  if (continueExiting) return;
                  e.currentTarget.style.borderColor = "#C4A265";
                  e.currentTarget.style.color = "#C4A265";
                }}
                onMouseLeave={(e) => {
                  if (continueExiting) return;
                  e.currentTarget.style.borderColor = "rgba(47, 57, 44, 0.25)";
                  e.currentTarget.style.color = "#2F392C";
                }}
              >
                Continue
              </button>
            )}

            {/* Split into two choices (always in flow to reserve height) */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto 1fr",
                alignItems: "stretch",
                width: "100%",
                maxWidth: "56rem",
                pointerEvents: showModePicker && !isTransitioning ? "auto" : "none",
              }}
            >
              {([
                {
                  label: "Talk to Aoede",
                  sub: "Let our voice guide walk you through setup, hands-free. Just speak and Aoede sets everything up for you.",
                  onClick: handleVoiceMode,
                  align: "flex-end" as const,
                  textAlign: "right" as const,
                  delay: "0.3s",
                },
                {
                  label: "Explore manually",
                  sub: "Step through Matrix OS at your own pace and configure things exactly how you like them.",
                  onClick: handleStartManual,
                  align: "flex-start" as const,
                  textAlign: "left" as const,
                  delay: "0.45s",
                },
              ] as const).map((item, i) => (
                <button
                  key={i}
                  onClick={item.onClick}
                  disabled={isTransitioning}
                  style={{
                    gridColumn: i === 0 ? 1 : 3,
                    gridRow: 1,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: item.align,
                    justifyContent: "center",
                    gap: "0.7rem",
                    padding: "1.5rem 2.5rem",
                    textAlign: item.textAlign,
                    fontFamily: "var(--font-inter), system-ui, sans-serif",
                    color: "#2F392C",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    borderRadius: "14px",
                    opacity: splitVisible ? 1 : 0,
                    transform: splitVisible ? "translateY(0) scale(1)" : "translateY(18px) scale(0.97)",
                    transition:
                      `opacity 1s cubic-bezier(0.16, 1, 0.3, 1) ${item.delay}, transform 1s cubic-bezier(0.16, 1, 0.3, 1) ${item.delay}, background 0.4s cubic-bezier(0.16, 1, 0.3, 1)`,
                  }}
                  onMouseEnter={(e) => {
                    const btn = e.currentTarget;
                    btn.style.background = "rgba(196, 162, 101, 0.07)";
                    const label = btn.querySelector("[data-label]") as HTMLElement;
                    if (label) label.style.color = "#C4A265";
                    const line = btn.querySelector("[data-line]") as HTMLElement;
                    if (line) line.style.width = "3rem";
                  }}
                  onMouseLeave={(e) => {
                    const btn = e.currentTarget;
                    btn.style.background = "none";
                    const label = btn.querySelector("[data-label]") as HTMLElement;
                    if (label) label.style.color = "#2F392C";
                    const line = btn.querySelector("[data-line]") as HTMLElement;
                    if (line) line.style.width = "1.5rem";
                  }}
                >
                  <span
                    data-label=""
                    style={{
                      fontSize: "1.15rem",
                      fontWeight: 600,
                      letterSpacing: "0.01em",
                      transition: "color 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                  >
                    {item.label}
                  </span>
                  <span
                    data-line=""
                    style={{
                      width: "1.5rem",
                      height: "2px",
                      background: "#C4A265",
                      borderRadius: "2px",
                      transition: "width 0.4s cubic-bezier(0.16, 1, 0.3, 1)",
                    }}
                  />
                  <span
                    style={{
                      fontSize: "0.82rem",
                      fontWeight: 400,
                      lineHeight: 1.6,
                      opacity: 0.55,
                      maxWidth: "16rem",
                    }}
                  >
                    {item.sub}
                  </span>
                </button>
              ))}

              {/* Vertical divider — grows from center */}
              <div
                aria-hidden
                style={{
                  width: "1px",
                  alignSelf: "stretch",
                  margin: "0.5rem 0",
                  background: "linear-gradient(to bottom, transparent, rgba(47, 57, 44, 0.2) 20%, rgba(47, 57, 44, 0.2) 80%, transparent)",
                  gridColumn: "2",
                  gridRow: "1",
                  transformOrigin: "center",
                  transform: splitVisible ? "scaleY(1)" : "scaleY(0)",
                  opacity: splitVisible ? 1 : 0,
                  transition: "transform 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.2s, opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1) 0.2s",
                }}
              />
            </div>
          </div>
        </div>

        {/* Skip — anchored to bottom */}
        <div
          className="flex justify-center mb-8"
          style={{
            transition: "opacity 0.8s cubic-bezier(0.16, 1, 0.3, 1)",
            opacity: isTransitioning ? 0 : 1,
            position: "relative",
            zIndex: 2,
          }}
        >
          <button
            onClick={() => {
              onOpenTerminal();
              onComplete();
            }}
            style={{
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              fontSize: "0.625rem",
              fontWeight: 400,
              letterSpacing: "0.06em",
              color: "#2F392C",
              opacity: 0.35,
              background: "none",
              border: "none",
              cursor: "pointer",
              transition: "opacity 0.3s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.35"; }}
          >
            Skip first-time setup
          </button>
        </div>

        {/* Dimming overlay — for voice mode */}
        {!manualMode && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              backgroundColor: "var(--background)",
              opacity: phase === "dimming" || phase === "black" ? 1 : 0,
              transition: `opacity ${phase === "dimming" ? "1.4s" : "0s"} cubic-bezier(0.4, 0, 0.2, 1)`,
              zIndex: 3,
            }}
          />
        )}

      </div>
    )}

    <div
      className="fixed inset-0 z-50 flex flex-col overflow-hidden"
      style={{
        backgroundColor: manualMode ? "#FFFDF6" : "var(--background)",
      }}
    >

      {/* ── Manual guided walkthrough ── */}
      {manualMode && phase === "revealing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
          <div
            className="max-w-lg text-center flex flex-col items-center"
            style={{ gap: "2rem" }}
          >
            {/* Heading — clean scale-up reveal; mirrors out via onboard-text-fall */}
            <h2
              key={`heading-${manualStep}`}
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "clamp(2.2rem, 6vw, 3.5rem)",
                fontWeight: 300,
                color: "#2F392C",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
                opacity: 0,
                transform: "scale(0.94) translateY(10px)",
                ...(exiting
                  ? {
                      animation: "onboard-text-fall 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both",
                    }
                  : headingVisible
                    ? {
                        animation: "onboard-text-rise 2s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                      }
                    : {}),
              }}
            >
              {MANUAL_STEPS[manualStep].heading}
            </h2>

            {/* Body — clean scale-up reveal; mirrors out via onboard-text-fall */}
            <p
              key={`body-${manualStep}`}
              style={{
                fontFamily: "var(--font-inter), system-ui, sans-serif",
                fontSize: "1rem",
                fontWeight: 400,
                color: "#2F392C",
                lineHeight: 1.8,
                maxWidth: "28rem",
                opacity: 0,
                transform: "scale(0.94) translateY(10px)",
                ...(exiting
                  ? {
                      animation: "onboard-text-fall 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0.15s both",
                    }
                  : bodyVisible
                    ? {
                        animation: "onboard-text-rise 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                      }
                    : {}),
              }}
            >
              {MANUAL_STEPS[manualStep].body}
            </p>

            {/* Continue button — clean scale-up reveal; mirrors out via onboard-text-fall */}
            <button
              key={`btn-${manualStep}`}
              onClick={handleManualNext}
              style={{
                marginTop: "0.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontFamily: "var(--font-inter), system-ui, sans-serif",
                fontSize: "0.8rem",
                fontWeight: 500,
                letterSpacing: "0.03em",
                color: "#2F392C",
                background: "none",
                border: "none",
                borderBottom: "1px solid #D6D0C4",
                paddingBottom: "0.25rem",
                cursor: "pointer",
                opacity: 0,
                transform: "scale(0.94) translateY(10px)",
                ...(exiting
                  ? {
                      animation: "onboard-text-fall 0.8s cubic-bezier(0.16, 1, 0.3, 1) 0s both",
                    }
                  : buttonVisible
                    ? {
                        animation: "onboard-text-rise 1.4s cubic-bezier(0.16, 1, 0.3, 1) forwards",
                      }
                    : {}),
                transition: "gap 0.4s cubic-bezier(0.16, 1, 0.3, 1), border-bottom-color 0.3s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.gap = "0.75rem";
                e.currentTarget.style.borderBottomColor = "#2F392C";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.gap = "0.5rem";
                e.currentTarget.style.borderBottomColor = "#D6D0C4";
              }}
            >
              {manualStep < MANUAL_STEPS.length - 1 ? "Continue" : "Get started"}
              <ArrowRightIcon style={{ width: "14px", height: "14px" }} />
            </button>
          </div>

          {/* Skip */}
          <button
            onClick={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
              onComplete();
            }}
            style={{
              position: "absolute",
              bottom: "1.5rem",
              left: "50%",
              transform: "translateX(-50%)",
              fontFamily: "var(--font-inter), system-ui, sans-serif",
              fontSize: "0.625rem",
              fontWeight: 400,
              letterSpacing: "0.06em",
              color: "#2F392C",
              opacity: buttonVisible ? 0.35 : 0,
              background: "none",
              border: "none",
              cursor: "pointer",
              transition: "opacity 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.7"; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = "0.35"; }}
          >
            skip
          </button>
        </div>
      )}

      {/* ── Voice conversation screen ── */}
      {!manualMode && isConversing && (
        <>
          <div className="absolute inset-x-0 flex flex-col items-center px-6" style={{ bottom: "28%" }}>
            <p
              className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground/70 mb-4"
              style={{ fontFamily: "var(--font-inter), system-ui, sans-serif" }}
            >
              Aoede &middot; Matrix OS
            </p>

            <div className="max-w-xl text-center min-h-[2em]">
              <p
                className="text-xl md:text-2xl font-light text-foreground/90 leading-relaxed transition-opacity duration-300"
                style={{
                  fontFamily: "var(--font-serif), Georgia, serif",
                  opacity: subtitle ? 1 : 0.3,
                }}
              >
                {subtitle || "..."}
              </p>
            </div>

            {!ob.isVoiceMode && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("msg") as HTMLInputElement;
                  if (input.value.trim()) {
                    ob.sendText(input.value.trim());
                    input.value = "";
                  }
                }}
                className="flex gap-2 mt-8 w-full max-w-md"
              >
                <input
                  name="msg"
                  type="text"
                  placeholder="Type your response..."
                  className="flex-1 px-4 py-3 rounded-xl bg-muted/30 border border-border/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/20 text-sm"
                  autoFocus
                />
                <button
                  type="submit"
                  className="px-5 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  Send
                </button>
              </form>
            )}
          </div>

          <div className="absolute inset-x-0 bottom-[8%] h-[160px]">
            <VoiceWave state={ob.voiceState} />
          </div>

          <button
            onClick={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
              onComplete();
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-2"
          >
            <span className="text-base leading-none">&rsaquo;</span> Skip Intro
          </button>
        </>
      )}

      {/* Stage: API key */}
      {ob.stage === "api_key" && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <ApiKeyInput
            onSubmit={ob.sendApiKey}
            result={ob.apiKeyResult}
            onSkip={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
              onComplete();
            }}
          />
        </div>
      )}

      {/* Stage: done */}
      {ob.stage === "done" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
          <p
            className="text-2xl font-light text-foreground"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            You&rsquo;re all set
          </p>
          <p className="text-sm text-muted-foreground">Loading your workspace...</p>
        </div>
      )}

      {/* Error */}
      {ob.error && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-xs">
          {ob.error}
        </div>
      )}
    </div>
    </>
  );
}
