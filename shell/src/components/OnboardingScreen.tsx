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

interface OnboardingScreenProps {
  onComplete: () => void;
  onOpenTerminal: () => void;
}

export function OnboardingScreen({ onComplete, onOpenTerminal }: OnboardingScreenProps) {
  const ob = useOnboarding();
  const mic = useMicPermission();
  const [phase, setPhase] = useState<"idle" | "lifting" | "dimming" | "black" | "revealing">("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualStep, setManualStep] = useState(0);
  const [stepVisible, setStepVisible] = useState(false);
  const [headingVisible, setHeadingVisible] = useState(false);
  const [bodyVisible, setBodyVisible] = useState(false);
  const [buttonVisible, setButtonVisible] = useState(false);
  const [lineVisible, setLineVisible] = useState(false);
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

    setStepVisible(false);
    setHeadingVisible(false);
    setBodyVisible(false);
    setButtonVisible(false);
    setLineVisible(false);

    const t0 = setTimeout(() => setLineVisible(true), 300);
    const t1 = setTimeout(() => setStepVisible(true), 500);
    const t2 = setTimeout(() => setHeadingVisible(true), 900);
    const t3 = setTimeout(() => setBodyVisible(true), 1500);
    const t4 = setTimeout(() => setButtonVisible(true), 2100);

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
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

  function handleStartManual() {
    setManualMode(true);
    setPhase("lifting");
    setTimeout(() => {
      setPhase("dimming");
      setTimeout(() => {
        setPhase("black");
        setTimeout(() => setPhase("revealing"), 1000);
      }, 2000);
    }, 800);
  }

  function handleManualNext() {
    setButtonVisible(false);
    setTimeout(() => setBodyVisible(false), 80);
    setTimeout(() => setHeadingVisible(false), 160);
    setTimeout(() => setLineVisible(false), 240);
    setTimeout(() => setStepVisible(false), 320);

    setTimeout(() => {
      if (manualStep < MANUAL_STEPS.length - 1) {
        setManualStep((s) => s + 1);
      } else {
        setManualMode(false);
        ob.start(false);
      }
    }, 800);
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
  const isLifting = phase === "lifting" || phase === "dimming" || phase === "black";

  return (
    <>
    {/* Landing screen — stays mounted as overlay during transition */}
    {phase !== "revealing" && (
      <div className="fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: "var(--background)" }}>
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        <div className="flex-1 flex flex-col items-center justify-center gap-16">
          {/* Title — "Enter Matrix OS" with gilded shimmer */}
          <h1
            className="cursor-default select-none"
            style={{
              fontFamily: "var(--font-serif), Georgia, serif",
              fontSize: "clamp(2rem, 5vw, 3rem)",
              fontWeight: 300,
              letterSpacing: "-0.02em",
              lineHeight: 1.1,
              transition: "all 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
              transform: isLifting ? "translateY(-24px) scale(1.06)" : "translateY(0) scale(1)",
              opacity: phase === "black" ? 0 : 1,
            }}
          >
            <span
              style={{
                backgroundClip: "text",
                WebkitBackgroundClip: "text",
                color: "transparent",
                backgroundImage: isTransitioning
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

          {/* Mode picker — separated left/right */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "3rem",
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
                transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
                borderBottom: "1px solid transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.color = "var(--foreground)";
                e.currentTarget.style.borderBottomColor = "var(--foreground)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.6";
                e.currentTarget.style.color = "var(--muted-foreground)";
                e.currentTarget.style.borderBottomColor = "transparent";
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
                transition: "all 0.5s cubic-bezier(0.16, 1, 0.3, 1)",
                borderBottom: "1px solid transparent",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.opacity = "1";
                e.currentTarget.style.color = "var(--foreground)";
                e.currentTarget.style.borderBottomColor = "var(--foreground)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = "0.6";
                e.currentTarget.style.color = "var(--muted-foreground)";
                e.currentTarget.style.borderBottomColor = "transparent";
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

        {/* Dimming overlay */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundColor: "var(--background)",
            opacity: phase === "dimming" || phase === "black" ? 1 : 0,
            transition: `opacity ${phase === "dimming" ? (manualMode ? "2s" : "1.4s") : "0s"} cubic-bezier(0.4, 0, 0.2, 1)`,
          }}
        />
      </div>
    )}

    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden" style={{ backgroundColor: "var(--background)" }}>

      {/* ── Manual guided walkthrough ── */}
      {manualMode && phase === "revealing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
          <div
            className="max-w-lg text-center flex flex-col items-center"
            style={{ gap: "2rem" }}
          >
            {/* Decorative line — grows from center */}
            <div
              style={{
                width: "3rem",
                height: "1px",
                backgroundColor: "var(--border)",
                transition: "all 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
                transform: lineVisible ? "scaleX(1)" : "scaleX(0)",
                opacity: lineVisible ? 1 : 0,
              }}
            />

            {/* Step indicator */}
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                transition: "all 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
                opacity: stepVisible ? 0.6 : 0,
                transform: stepVisible ? "translateY(0)" : "translateY(-6px)",
              }}
            >
              {MANUAL_STEPS.map((_, i) => (
                <div
                  key={i}
                  style={{
                    height: "2px",
                    borderRadius: "1px",
                    transition: "all 0.8s cubic-bezier(0.16, 1, 0.3, 1)",
                    width: i === manualStep ? "2rem" : "1rem",
                    backgroundColor: i <= manualStep ? "var(--foreground)" : "var(--border)",
                    opacity: i <= manualStep ? 0.4 : 0.3,
                  }}
                />
              ))}
            </div>

            {/* Heading */}
            <h2
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "clamp(1.75rem, 4vw, 2.5rem)",
                fontWeight: 300,
                color: "var(--foreground)",
                letterSpacing: "-0.02em",
                lineHeight: 1.2,
                transition: "all 1.4s cubic-bezier(0.16, 1, 0.3, 1)",
                opacity: headingVisible ? 1 : 0,
                transform: headingVisible ? "translateY(0)" : "translateY(32px)",
              }}
            >
              {MANUAL_STEPS[manualStep].heading}
            </h2>

            {/* Body */}
            <p
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "1.05rem",
                fontWeight: 300,
                color: "var(--muted-foreground)",
                lineHeight: 1.8,
                maxWidth: "28rem",
                transition: "all 1.4s cubic-bezier(0.16, 1, 0.3, 1)",
                opacity: bodyVisible ? 1 : 0,
                transform: bodyVisible ? "translateY(0)" : "translateY(32px)",
              }}
            >
              {MANUAL_STEPS[manualStep].body}
            </p>

            {/* Continue button — minimal, editorial */}
            <button
              onClick={handleManualNext}
              style={{
                marginTop: "0.5rem",
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                fontFamily: "var(--font-serif), Georgia, serif",
                fontSize: "0.875rem",
                fontWeight: 300,
                fontStyle: "italic",
                color: "var(--foreground)",
                background: "none",
                border: "none",
                borderBottom: "1px solid var(--border)",
                paddingBottom: "0.25rem",
                cursor: "pointer",
                transition: "all 1.2s cubic-bezier(0.16, 1, 0.3, 1)",
                opacity: buttonVisible ? 1 : 0,
                transform: buttonVisible ? "translateY(0)" : "translateY(24px)",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.gap = "0.75rem";
                e.currentTarget.style.borderBottomColor = "var(--foreground)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.gap = "0.5rem";
                e.currentTarget.style.borderBottomColor = "var(--border)";
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
              color: "var(--muted-foreground)",
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
