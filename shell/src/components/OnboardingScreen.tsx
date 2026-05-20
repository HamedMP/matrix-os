"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { MicPermissionDialog } from "./MicPermissionDialog";
import { MicIcon, BookOpenIcon, ArrowRightIcon } from "lucide-react";

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
  const [phase, setPhase] = useState<"idle" | "dimming" | "black" | "revealing">("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [manualStep, setManualStep] = useState(0);
  const [stepVisible, setStepVisible] = useState(false);
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

    setStepVisible(false);
    setHeadingVisible(false);
    setBodyVisible(false);
    setButtonVisible(false);

    const t1 = setTimeout(() => setStepVisible(true), 200);
    const t2 = setTimeout(() => setHeadingVisible(true), 600);
    const t3 = setTimeout(() => setBodyVisible(true), 1100);
    const t4 = setTimeout(() => setButtonVisible(true), 1600);

    return () => {
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
    setPhase("dimming");
    setTimeout(() => {
      setPhase("black");
      startAmbientAudio();
      ob.start(true);
      setTimeout(() => setPhase("revealing"), 400);
    }, 1200);
  }

  function handleStartManual() {
    setManualMode(true);
    setPhase("dimming");
    setTimeout(() => {
      setPhase("black");
      setTimeout(() => setPhase("revealing"), 800);
    }, 1800);
  }

  function handleManualNext() {
    // Fade everything out
    setButtonVisible(false);
    setTimeout(() => setBodyVisible(false), 100);
    setTimeout(() => setHeadingVisible(false), 200);
    setTimeout(() => setStepVisible(false), 300);

    setTimeout(() => {
      if (manualStep < MANUAL_STEPS.length - 1) {
        setManualStep((s) => s + 1);
      } else {
        setManualMode(false);
        ob.start(false);
      }
    }, 700);
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

  return (
    <>
    {/* Landing screen — stays mounted as overlay during transition */}
    {phase !== "revealing" && (
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        <div className="flex-1 flex flex-col items-center justify-center gap-16">
          {/* Title — original "Enter Matrix OS" shimmer + scale */}
          <h1
            className="text-4xl font-light tracking-tight text-foreground hover:scale-110 transition-transform duration-700 ease-out cursor-default"
            style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
          >
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage:
                  phase === "dimming"
                    ? "linear-gradient(90deg, var(--primary) 0%, var(--primary) 100%)"
                    : "linear-gradient(90deg, var(--foreground) 0%, var(--foreground) 35%, var(--primary) 50%, var(--foreground) 65%, var(--foreground) 100%)",
                backgroundSize: "200% 100%",
                animation: phase === "idle" ? "shimmer 6s ease-in-out infinite" : "none",
                transition: "all 1.2s ease-in-out",
              }}
            >
              Enter Matrix OS
            </span>
          </h1>

          {/* Mode picker */}
          <div
            className="flex gap-5 transition-all duration-700 ease-out"
            style={{
              opacity: phase !== "idle" ? 0 : 1,
              transform: phase !== "idle" ? "translateY(8px)" : "translateY(0)",
              pointerEvents: phase !== "idle" ? "none" : "auto",
            }}
          >
            {/* Voice mode */}
            <button
              onClick={handleVoiceMode}
              disabled={phase !== "idle"}
              className="group relative flex flex-col items-center gap-4 px-10 py-8 rounded-2xl border border-border/50 bg-card/50 hover:bg-card hover:border-primary/30 hover:shadow-lg transition-all duration-300"
            >
              <div className="size-12 rounded-full bg-primary/10 group-hover:bg-primary/20 flex items-center justify-center transition-colors duration-300">
                <MicIcon className="size-5 text-primary" />
              </div>
              <div className="flex flex-col items-center gap-1">
                <span
                  className="text-base font-light text-foreground"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  Talk to Aoede
                </span>
                <span className="text-[11px] text-muted-foreground/70">
                  Voice conversation
                </span>
              </div>
            </button>

            {/* Manual guided mode */}
            <button
              onClick={handleStartManual}
              disabled={phase !== "idle"}
              className="group relative flex flex-col items-center gap-4 px-10 py-8 rounded-2xl border border-border/50 bg-card/50 hover:bg-card hover:border-primary/30 hover:shadow-lg transition-all duration-300"
            >
              <div className="size-12 rounded-full bg-primary/10 group-hover:bg-primary/20 flex items-center justify-center transition-colors duration-300">
                <BookOpenIcon className="size-5 text-primary" />
              </div>
              <div className="flex flex-col items-center gap-1">
                <span
                  className="text-base font-light text-foreground"
                  style={{ fontFamily: "var(--font-serif), Georgia, serif" }}
                >
                  Read &amp; explore
                </span>
                <span className="text-[11px] text-muted-foreground/70">
                  Guided walkthrough
                </span>
              </div>
            </button>
          </div>
        </div>

        <div
          className="flex justify-center mb-8 transition-opacity duration-500"
          style={{ opacity: phase !== "idle" ? 0 : 1 }}
        >
          <button
            onClick={() => {
              onOpenTerminal();
              onComplete();
            }}
            className="text-[10px] text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            Skip first-time setup
          </button>
        </div>

        {/* Dimming overlay — slower for manual mode */}
        <div
          className="absolute inset-0 bg-background pointer-events-none transition-opacity ease-in-out"
          style={{
            opacity: phase === "dimming" || phase === "black" ? 1 : 0,
            transitionDuration: phase === "dimming" ? (manualMode ? "1.8s" : "1.2s") : "0s",
          }}
        />
      </div>
    )}

    <div className="fixed inset-0 z-50 flex flex-col bg-background overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-muted/30" />

      {/* ── Manual guided walkthrough ── */}
      {manualMode && phase === "revealing" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center px-6">
          <div className="max-w-lg text-center flex flex-col items-center gap-8">
            {/* Step indicator */}
            <div
              className="flex gap-2 mb-2 transition-all duration-1000 ease-out"
              style={{
                opacity: stepVisible ? 1 : 0,
                transform: stepVisible ? "translateY(0)" : "translateY(-8px)",
              }}
            >
              {MANUAL_STEPS.map((_, i) => (
                <div
                  key={i}
                  className="h-0.5 rounded-full transition-all duration-700 ease-out"
                  style={{
                    width: i === manualStep ? "2rem" : "1.5rem",
                    backgroundColor: i <= manualStep ? "var(--primary)" : "var(--border)",
                  }}
                />
              ))}
            </div>

            {/* Heading */}
            <h2
              className="text-3xl md:text-4xl font-light text-foreground transition-all duration-1000 ease-out"
              style={{
                fontFamily: "var(--font-serif), Georgia, serif",
                opacity: headingVisible ? 1 : 0,
                transform: headingVisible ? "translateY(0)" : "translateY(20px)",
              }}
            >
              {MANUAL_STEPS[manualStep].heading}
            </h2>

            {/* Body */}
            <p
              className="text-base md:text-lg text-muted-foreground leading-relaxed max-w-md transition-all duration-1000 ease-out"
              style={{
                opacity: bodyVisible ? 1 : 0,
                transform: bodyVisible ? "translateY(0)" : "translateY(20px)",
              }}
            >
              {MANUAL_STEPS[manualStep].body}
            </p>

            {/* Continue button */}
            <button
              onClick={handleManualNext}
              className="mt-2 flex items-center gap-2 px-6 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 hover:gap-3 transition-all duration-500 ease-out"
              style={{
                opacity: buttonVisible ? 1 : 0,
                transform: buttonVisible ? "translateY(0)" : "translateY(16px)",
              }}
            >
              {manualStep < MANUAL_STEPS.length - 1 ? "Continue" : "Get started"}
              <ArrowRightIcon className="size-4" />
            </button>
          </div>

          {/* Skip */}
          <button
            onClick={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
              onComplete();
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-2"
            style={{
              opacity: buttonVisible ? 1 : 0,
              transition: "opacity 1s ease-out, color 0.2s",
            }}
          >
            <span className="text-base leading-none">&rsaquo;</span> Skip
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
            You're all set
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
