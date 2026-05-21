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
    heading: "One last thing",
    body: "To unlock the full experience, you'll need an Anthropic API key. This powers the AI that runs throughout Matrix OS.",
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
  const [headingVisible, setHeadingVisible] = useState(false);
  const [bodyVisible, setBodyVisible] = useState(false);
  const [buttonVisible, setButtonVisible] = useState(false);
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
    if (ob.stage === "done" && gainNodeRef.current && audioCtxRef.current) {
      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2);
      setTimeout(onComplete, 2000);
    } else if (ob.stage === "done") {
      setTimeout(onComplete, 800);
    }
  }, [ob.stage, ob.alreadyComplete, onComplete]);

  useEffect(() => {
    return () => {
      ambientRef.current?.pause();
      audioCtxRef.current?.close();
    };
  }, []);

  // Staggered reveal for manual walkthrough steps
  useEffect(() => {
    if (!manualMode || phase !== "revealing") return;

    setHeadingVisible(false);
    setBodyVisible(false);
    setButtonVisible(false);

    const t0 = setTimeout(() => setHeadingVisible(true), 150);
    const t1 = setTimeout(() => setBodyVisible(true), 1200);
    const t2 = setTimeout(() => setButtonVisible(true), 1900);

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

  // Luxurious manual mode entry: longer, slower phases for a sumptuous feel
  function handleStartManual() {
    setManualMode(true);
    setPhase("ascending");
    // Hold the ascension longer — the title glows, lifts gracefully
    setTimeout(() => {
      setPhase("whiteout");
      // Linger in pure white before revealing
      setTimeout(() => {
        setPhase("revealing");
      }, 2400);
    }, 2800);
  }

  function handleManualNext() {
    setButtonVisible(false);
    setTimeout(() => setBodyVisible(false), 60);
    setTimeout(() => setHeadingVisible(false), 120);

    setTimeout(() => {
      if (manualStep < MANUAL_STEPS.length - 1) {
        setManualStep((s) => s + 1);
      } else if (onStartTour) {
        onStartTour();
      } else {
        setManualMode(false);
        ob.start(false);
      }
    }, 500);
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
          className="flex-1 flex flex-col items-center justify-center gap-16"
          style={{
            position: "relative",
            zIndex: 2,
            // Subtle camera-tilt-up: the whole page scales slightly as you ascend into the light
            transformOrigin: "center 40%",
            transition: "transform 3.5s cubic-bezier(0.22, 1, 0.36, 1), filter 3.5s cubic-bezier(0.22, 1, 0.36, 1)",
            transform: (phase === "ascending" || phase === "whiteout") ? "scale(1.04) translateY(-8px)" : "scale(1) translateY(0)",
            filter: (phase === "ascending" || phase === "whiteout") ? "brightness(1.08)" : "brightness(1)",
          }}
        >
          {/* Title — "Enter Matrix OS" with gilded shimmer */}
          <h1
            className="cursor-default select-none"
            style={{
              fontFamily: "var(--font-serif), Georgia, serif",
              fontSize: "clamp(2rem, 5vw, 3rem)",
              fontWeight: 300,
              letterSpacing: "-0.02em",
              lineHeight: 1.1,
              ...(phase === "ascending" || phase === "whiteout"
                ? {
                    animation: "onboard-ascend-lux 4s cubic-bezier(0.22, 1, 0.36, 1) forwards",
                  }
                : {
                    transition: "all 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
                    transform: isPreReveal ? "translateY(-24px) scale(1.06)" : "translateY(0) scale(1)",
                    opacity: phase === "black" ? 0 : 1,
                  }),
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
                      : "linear-gradient(90deg, var(--foreground) 0%, var(--foreground) 25%, #C4A265 50%, var(--foreground) 75%, var(--foreground) 100%)",
                backgroundSize: "300% 100%",
                animation: !isTransitioning
                  ? "onboard-shimmer 6s ease-in-out infinite, onboard-glow 6s ease-in-out infinite"
                  : "none",
                transition: "background-image 1.6s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
            >
              Enter Matrix OS
            </span>
          </h1>

          {/* Mode picker — split at screen center */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              width: "100%",
              maxWidth: "32rem",
              transition: "all 1s cubic-bezier(0.16, 1, 0.3, 1)",
              opacity: isTransitioning ? 0 : 1,
              transform: isTransitioning ? "translateY(12px)" : "translateY(0)",
              pointerEvents: isTransitioning ? "none" : "auto",
            }}
          >
            <button
              onClick={handleVoiceMode}
              disabled={isTransitioning}
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "0.875rem",
                fontWeight: 300,
                color: "var(--muted-foreground)",
                opacity: 0.6,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0.25rem 0",
                textAlign: "right",
                paddingRight: "1.5rem",
                transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.color = "var(--foreground)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.6";
                e.currentTarget.style.color = "var(--muted-foreground)";
              }}
            >
              Interactive mode
            </button>

            <button
              onClick={handleStartManual}
              disabled={isTransitioning}
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "0.875rem",
                fontWeight: 300,
                color: "var(--muted-foreground)",
                opacity: 0.6,
                background: "none",
                border: "none",
                cursor: "pointer",
                padding: "0.25rem 0",
                textAlign: "left",
                paddingLeft: "1.5rem",
                transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.color = "var(--foreground)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.6";
                e.currentTarget.style.color = "var(--muted-foreground)";
              }}
            >
              Manual mode
            </button>
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
              fontFamily: "var(--font-serif), Georgia, serif",
              fontSize: "0.625rem",
              fontStyle: "italic",
              color: "var(--muted-foreground)",
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

        {/* Brightening overlay — full-screen radial gradient, no visible edges */}
        {(phase === "ascending" || phase === "whiteout") && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 1,
              pointerEvents: "none",
              // Soft radial that brightens the entire page from center outward,
              // with edges that blend into the warm cream background so no
              // discrete circle is visible.
              background:
                "radial-gradient(ellipse at center, rgba(255,253,240,0.95) 0%, rgba(252,246,232,0.85) 35%, rgba(247,241,231,0.6) 60%, rgba(247,241,231,0) 100%)",
              animation: "onboard-brighten 3s cubic-bezier(0.22, 1, 0.36, 1) forwards",
            }}
          />
        )}

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

        {/* White wash — for manual mode heavenly transition */}
        {manualMode && (
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background: "linear-gradient(180deg, #FFFDF6 0%, #FFF9EC 50%, #FFFDF6 100%)",
              opacity: phase === "whiteout" ? 1 : 0,
              transition: `opacity ${phase === "ascending" ? "0s" : "1.4s"} cubic-bezier(0.4, 0, 0.2, 1)`,
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
            {/* Heading — left-to-right sweep reveal */}
            <h2
              key={`heading-${manualStep}`}
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "clamp(2.2rem, 6vw, 3.5rem)",
                fontWeight: 300,
                color: "#32352E",
                letterSpacing: "-0.02em",
                lineHeight: 1.1,
                opacity: 0,
                ...(headingVisible
                  ? {
                      animation: "onboard-reveal-sweep-slow 1.8s cubic-bezier(0.22, 1, 0.36, 1) forwards",
                    }
                  : {}),
              }}
            >
              {MANUAL_STEPS[manualStep].heading}
            </h2>

            {/* Body — left-to-right sweep */}
            <p
              key={`body-${manualStep}`}
              style={{
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: "1.05rem",
                fontWeight: 300,
                color: "#7A7768",
                lineHeight: 1.8,
                maxWidth: "28rem",
                opacity: 0,
                ...(bodyVisible
                  ? {
                      animation: "onboard-reveal-sweep 1.6s cubic-bezier(0.22, 1, 0.36, 1) forwards",
                    }
                  : {}),
              }}
            >
              {MANUAL_STEPS[manualStep].body}
            </p>

            {/* Continue button — left-to-right sweep */}
            <button
              key={`btn-${manualStep}`}
              onClick={handleManualNext}
              style={{
                marginTop: "0.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontFamily: "Arial, Helvetica, sans-serif",
                fontSize: "0.875rem",
                fontWeight: 400,
                color: "#32352E",
                background: "none",
                border: "none",
                borderBottom: "1px solid #D6D0C4",
                paddingBottom: "0.25rem",
                cursor: "pointer",
                opacity: 0,
                ...(buttonVisible
                  ? {
                      animation: "onboard-reveal-sweep 1.2s cubic-bezier(0.22, 1, 0.36, 1) forwards",
                    }
                  : {}),
                transition: "gap 0.4s cubic-bezier(0.16, 1, 0.3, 1), border-bottom-color 0.3s",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.gap = "0.75rem";
                e.currentTarget.style.borderBottomColor = "#32352E";
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
              fontFamily: "var(--font-serif), Georgia, serif",
              fontSize: "0.625rem",
              fontStyle: "italic",
              letterSpacing: "0.15em",
              color: "#7A7768",
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
