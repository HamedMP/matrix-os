"use client";

import { useState, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { MicPermissionDialog } from "./MicPermissionDialog";
import { KeyboardIcon, MicIcon, SparklesIcon } from "lucide-react";
import { MATRIX_ONBOARDING_BRAND_VERSION } from "@/lib/onboarding-brand";
import { ShellNotificationCard } from "./ShellNotificationCard";
import { ShellNotificationStack } from "./ShellNotificationStack";
import { SHELL_Z_CLASSES } from "@/lib/shell-layering";

const SHIMMER_GRADIENT =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 24%, #C4A265 50%, #2F392C 76%, #2F392C 100%)";
const SHIMMER_ANIMATION =
  "onboard-shimmer 8s ease-in-out infinite, onboard-glow 8s ease-in-out infinite";

interface OnboardingScreenProps {
  onComplete: () => void;
  onOpenManualSetup: () => void;
}

// react-doctor-disable-next-line react-doctor/no-giant-component -- cohesive single-purpose onboarding flow: the choreographed entrance/dimming/reveal phases, mic + mode dialogs, and voice/text panels are one tightly-coupled animation sequence that shares timers and transition state; splitting it would scatter the choreography and add prop-drilling without reducing real complexity.
// react-doctor-disable-next-line react-doctor/prefer-useReducer -- the seven states (started, phase, showMicDialog, showModePicker, splitVisible, continueExiting, entranceStage) are independent transition/dialog flags driven from separate timers and event handlers, not one related state machine; collapsing them into a reducer would couple unrelated animation phases and is not a mechanical, behavior-identical change.
export function OnboardingScreen({ onComplete, onOpenManualSetup }: OnboardingScreenProps) {
  const ob = useOnboarding();
  const mic = useMicPermission();
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "dimming" | "black" | "revealing">("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [splitVisible, setSplitVisible] = useState(false);
  const [continueExiting, setContinueExiting] = useState(false);
  const [entranceStage, setEntranceStage] = useState<"hidden" | "center" | "settled">("hidden");
  const ambientRef = useRef<HTMLAudioElement | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const continueTimerRef = useRef<number | null>(null);
  const continueFrameRef = useRef<number | null>(null);

  // Live subtitle — accumulated AI transcript fragments, synced with voice
  const subtitle = ob.currentSubtitle;

  useEffect(() => {
    const centerTimer = window.setTimeout(() => setEntranceStage("center"), 90);
    const settleTimer = window.setTimeout(() => setEntranceStage("settled"), 1_650);
    return () => {
      window.clearTimeout(centerTimer);
      window.clearTimeout(settleTimer);
    };
  }, []);

  // If onboarding is already complete, tell the parent to unmount us.
  // This must run as an effect -- calling onComplete() during render
  // triggers a parent setState mid-child-render, which React rejects.
  useEffect(() => {
    if (ob.alreadyComplete) {
      onComplete();
    }
  }, [ob.alreadyComplete, onComplete]);

  // Fade out ambient audio when done
  useEffect(() => {
    if (ob.alreadyComplete) return;
    let completeTimer: number | undefined;
    if (ob.stage === "done" && gainNodeRef.current && audioCtxRef.current) {
      const gain = gainNodeRef.current;
      const ctx = audioCtxRef.current;
      gain.gain.setValueAtTime(gain.gain.value, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 2);
      completeTimer = window.setTimeout(onComplete, 2000);
    } else if (ob.stage === "done") {
      completeTimer = window.setTimeout(onComplete, 800);
    }
    return () => {
      if (completeTimer !== undefined) window.clearTimeout(completeTimer);
    };
  }, [ob.stage, ob.alreadyComplete, onComplete]);

  // react-doctor-disable-next-line react-doctor/exhaustive-deps -- unmount-only cleanup must cancel whatever timer/frame is pending and tear down whatever audio nodes exist at teardown, so it must read .current at cleanup time; snapshotting these refs at mount would always capture their initial null values and never clean up.
  useEffect(() => {
    return () => {
      if (continueTimerRef.current !== null) {
        window.clearTimeout(continueTimerRef.current);
      }
      if (continueFrameRef.current !== null) {
        window.cancelAnimationFrame(continueFrameRef.current);
      }
      ambientRef.current?.pause();
      audioCtxRef.current?.close();
    };
  }, []);

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

  const handleStart = (useVoice: boolean) => {
    // Phase 1: dim into light (text glows and screen fades to white/black)
    setPhase("dimming");
    setTimeout(() => {
      // Phase 2: fully dark
      setPhase("black");
      setStarted(true);
      startAmbientAudio();
      ob.start(useVoice);
      setTimeout(() => {
        // Phase 3: reveal destination
        setPhase("revealing");
      }, 400);
    }, 1200);
  };

  const handleTalkToMe = async () => {
    if (mic.state === "granted") {
      handleStart(true);
      return;
    }
    if (mic.state === "denied") {
      setShowMicDialog(true);
      return;
    }
    // "prompt" or "checking": trigger the native browser prompt directly.
    const granted = await mic.requestAccess();
    if (granted) handleStart(true);
    else setShowMicDialog(true);
  };

  const handleMicAllow = async () => {
    const granted = await mic.requestAccess();
    setShowMicDialog(false);
    if (granted) {
      handleStart(true);
    }
  };

  const handleContinue = () => {
    setContinueExiting(true);
    if (continueTimerRef.current !== null) {
      window.clearTimeout(continueTimerRef.current);
    }
    continueTimerRef.current = window.setTimeout(() => {
      continueTimerRef.current = null;
      setShowModePicker(true);
      continueFrameRef.current = window.requestAnimationFrame(() => {
        continueFrameRef.current = window.requestAnimationFrame(() => {
          continueFrameRef.current = null;
          setSplitVisible(true);
        });
      });
    }, 520);
  };

  // ── Voice conversation screen (editorial style) ─────────────
  const isConversing = ob.stage === "greeting" || ob.stage === "interview" || ob.stage === "connecting";

  // Render nothing for the one frame between "alreadyComplete" becoming
  // true and the parent unmounting us via the effect above. Placing this
  // return AFTER all hooks keeps hook ordering stable.
  if (ob.alreadyComplete) {
    return null;
  }

  return (
    <>
    {/* Landing screen — stays mounted as overlay during transition */}
    {phase !== "revealing" && (
      <div className={`fixed inset-0 ${SHELL_Z_CLASSES.hardGate} flex flex-col bg-background`}>
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        <section
            data-onboarding-brand={MATRIX_ONBOARDING_BRAND_VERSION}
            className="relative flex min-h-full flex-1 flex-col overflow-hidden bg-[#fffdf6] text-[#2f392c]"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(196,162,101,0.12),transparent_30%),linear-gradient(180deg,#fffdf6_0%,#f5efe2_100%)]" />
            <div
              className="relative z-10 flex flex-1 flex-col items-center justify-center px-5"
              style={{ gap: showModePicker ? "2.5rem" : "2.25rem" }}
            >
              <div
                className="flex flex-col items-center"
                style={{
                  gap: "1.4rem",
                  transform: continueExiting ? "scale(0.82) translateY(-10px)" : "scale(1) translateY(0)",
                  // react-doctor-disable-next-line react-doctor/no-long-transition-duration -- deliberate page-load hero choreography (the rule explicitly exempts hero animations): this is the onboarding continue/exit transition, tuned to 1.5s to match the cinematic entrance sequence; shortening it to <1s would break the intended slow reveal pacing.
                  transition: "transform 1.5s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                <div
                  // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- not a plain <img>: the logo is rendered via a CSS mask of the SVG over an animated shimmer gradient background, which an <img> element cannot reproduce
                  role="img"
                  aria-label="Matrix OS logo"
                  className="h-[132px] w-[124px] sm:h-[156px] sm:w-[148px]"
                  style={{
                    WebkitMask: `url('/matrix-logo.svg') no-repeat center / contain`,
                    mask: `url('/matrix-logo.svg') no-repeat center / contain`,
                    background: `${SHIMMER_GRADIENT} 0 0 / 300% 100%`,
                    animation: phase === "idle" ? SHIMMER_ANIMATION : "none",
                    opacity: entranceStage === "hidden" || phase === "black" ? 0 : 1,
                    transform: entranceStage !== "settled"
                      ? "translateY(28vh) scale(1.5)"
                      : phase === "dimming"
                        ? "translateY(-20px) scale(1.05)"
                        : "translateY(0) scale(1)",
                    // react-doctor-disable-next-line react-doctor/no-long-transition-duration -- deliberate page-load hero choreography (the rule explicitly exempts hero animations): the logo entrance scales and rises into place over 1.6s as the signature onboarding reveal; clamping to <1s would break the intended cinematic pacing.
                    transition: "opacity 1s cubic-bezier(0.16, 1, 0.3, 1), transform 1.6s cubic-bezier(0.16, 1, 0.3, 1)",
                  }}
                />
                <h1
                  className="cursor-default select-none text-[clamp(1.7rem,4vw,2.55rem)] font-medium uppercase leading-none"
                  style={{
                    fontFamily: "var(--font-orbitron), var(--font-sans), system-ui, sans-serif",
                    opacity: entranceStage === "settled" && phase !== "black" ? 1 : 0,
                    transform: entranceStage === "settled" ? "translateY(0)" : "translateY(14px)",
                    transition: "opacity 1s cubic-bezier(0.16, 1, 0.3, 1) 0.25s, transform 1s cubic-bezier(0.16, 1, 0.3, 1) 0.25s",
                  }}
                >
                  <span
                    style={{
                      backgroundClip: "text",
                      WebkitBackgroundClip: "text",
                      color: "transparent",
                      backgroundImage: SHIMMER_GRADIENT,
                      backgroundSize: "300% 100%",
                      animation: phase === "idle" ? SHIMMER_ANIMATION : "none",
                    }}
                  >
                    Matrix OS
                  </span>
                </h1>
              </div>

              <div
                className="relative flex w-full max-w-4xl justify-center overflow-hidden md:overflow-visible"
                style={{
                  minHeight: showModePicker ? "min(52vh, 34rem)" : "12rem",
                  opacity: entranceStage === "settled" ? 1 : 0,
                  transition: "opacity 1s cubic-bezier(0.16, 1, 0.3, 1) 0.45s",
                }}
              >
                {!showModePicker && (
                  <button
                    type="button"
                    onClick={handleContinue}
                    disabled={phase !== "idle" || continueExiting}
                    className="absolute left-1/2 top-1/2 rounded-full border border-[#2f392c]/25 px-7 py-2 text-sm font-medium text-[#2f392c] transition hover:border-[#c4a265] hover:text-[#9d7d3d] disabled:pointer-events-none"
                    style={{
                      transform: continueExiting
                        ? "translate(-50%, calc(-50% + 10px)) scale(0.96)"
                        : "translate(-50%, -50%) scale(1)",
                      opacity: continueExiting ? 0 : 1,
                      transition: "opacity 0.5s cubic-bezier(0.4, 0, 0.2, 1), transform 0.5s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.3s, color 0.3s",
                    }}
                  >
                    Continue
                  </button>
                )}

                <div className="grid max-h-[52vh] w-full items-stretch gap-2 overflow-y-auto pr-1 sm:gap-3 md:max-h-none md:grid-cols-[1fr_auto_1fr_auto_1fr] md:overflow-visible md:pr-0">
                  {/* react-doctor-disable-next-line react-hooks-js/refs -- the mode-picker buttons wire to handlers (handleTalkToMe/onOpenManualSetup/onComplete) that legitimately read the imperative timer/audio refs (continueTimerRef, ambientRef, audioCtxRef) inside their own callbacks, never during render; those refs hold animation-frame/timer handles and an AudioContext that must not trigger re-renders. */}
                  {[
                    {
                      label: "Talk to Aoede",
                      description: "Let voice guide the first setup and explain what Matrix can do.",
                      icon: MicIcon,
                      onClick: handleTalkToMe,
                    },
                    {
                      label: "Set up manually",
                      description: "Place setup notes on your desktop and connect tools only when you need them.",
                      icon: SparklesIcon,
                      onClick: onOpenManualSetup,
                    },
                    {
                      label: "Enter workspace",
                      description: "Open Matrix now. Hermes stays active and optional setup remains available.",
                      icon: KeyboardIcon,
                      onClick: onComplete,
                    },
                  ].map((item, index) => {
                    const Icon = item.icon;
                    const gridColumn = index === 0 ? "md:col-start-1" : index === 1 ? "md:col-start-3" : "md:col-start-5";
                    return (
                      <button
                        key={item.label}
                        type="button"
                        onClick={item.onClick}
                        disabled={!showModePicker || phase !== "idle" || started}
                        className={`${gridColumn} group flex min-h-[8.25rem] flex-col justify-center rounded-md border border-transparent px-4 py-4 text-left text-[#2f392c] transition hover:border-[#c4a265]/30 hover:bg-[#c4a265]/10 disabled:pointer-events-none sm:min-h-[9rem] md:min-h-[10rem] md:px-6`}
                        style={{
                          opacity: splitVisible ? 1 : 0,
                          transform: splitVisible ? "translateY(0) scale(1)" : "translateY(18px) scale(0.98)",
                          transition: `opacity 0.9s cubic-bezier(0.16, 1, 0.3, 1) ${0.18 + index * 0.12}s, transform 0.9s cubic-bezier(0.16, 1, 0.3, 1) ${0.18 + index * 0.12}s, border-color 0.25s, background-color 0.25s`,
                        }}
                      >
                        <Icon className="mb-4 h-5 w-5 text-[#c4a265]" aria-hidden="true" />
                        <span className="text-base font-semibold">{item.label}</span>
                        <span className="mt-3 h-0.5 w-6 rounded-full bg-[#c4a265] transition-all group-hover:w-12" />
                        <span className="mt-4 max-w-[17rem] text-sm leading-6 text-[#2f392c]/58">
                          {item.description}
                        </span>
                      </button>
                    );
                  })}
                  <div className="hidden w-px bg-gradient-to-b from-transparent via-[#2f392c]/20 to-transparent md:col-start-2 md:row-start-1 md:block" style={{ opacity: splitVisible ? 1 : 0 }} />
                  <div className="hidden w-px bg-gradient-to-b from-transparent via-[#2f392c]/20 to-transparent md:col-start-4 md:row-start-1 md:block" style={{ opacity: splitVisible ? 1 : 0 }} />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={onComplete}
              className="relative z-10 mx-auto mb-7 text-xs text-[#2f392c]/40 transition hover:text-[#2f392c]/70"
              style={{ opacity: phase === "idle" ? 1 : 0 }}
            >
              Skip first-time setup
            </button>
          </section>

        {/* Dimming overlay */}
        <div
          className="absolute inset-0 bg-background pointer-events-none transition-opacity ease-in-out"
          style={{
            opacity: phase === "dimming" || phase === "black" ? 1 : 0,
            transitionDuration: phase === "dimming" ? "1.2s" : "0s",
          }}
        />
      </div>
    )}

    <div className="fixed inset-0 z-50 flex flex-col bg-background overflow-hidden">
      {/* Background — subtle gradient */}
      <div className="absolute inset-0 bg-gradient-to-b from-background via-background to-muted/30" />

      {/* Conversing layout: transcript centered, wave below, skip at bottom */}
      {isConversing && (
        <>
          {/* Center block: label + transcript */}
          <div className="absolute inset-x-0 flex flex-col items-center px-6" style={{ bottom: "28%" }}>
            {/* Label */}
            <p
              className="text-[11px] uppercase tracking-[0.25em] text-muted-foreground/70 mb-4"
              style={{ fontFamily: "var(--font-inter), system-ui, sans-serif" }}
            >
              Aoede · Matrix OS
            </p>

            {/* Live transcript — serif, editorial */}
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

            {/* Text input (text mode only) */}
            {!ob.isVoiceMode && (
              // react-doctor-disable-next-line react-doctor/no-prevent-default -- this is a client-only onboarding chat input with no server action; preventDefault stops a full-page GET navigation so ob.sendText() can handle the message in-place. There is no progressive-enhancement path here (onboarding requires JS), so a server action is not applicable.
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
                  aria-label="Your response"
                  className="flex-1 px-4 py-3 rounded-xl bg-muted/30 border border-border/50 text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/20 text-sm"
                  // react-doctor-disable-next-line react-doctor/no-autofocus -- primary text-response field in the conversational onboarding flow; focus is essential so the user can immediately type their reply
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

          {/* Voice wave — full width, below transcript */}
          <div className="absolute inset-x-0 bottom-[8%] h-[160px]">
            <VoiceWave state={ob.voiceState} />
          </div>

          {/* Skip intro — bottom */}
          <button
            type="button"
            onClick={() => {
              ob.chooseClaudeCode();
              onComplete();
            }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-muted-foreground transition-colors flex items-center gap-2"
          >
            <span className="text-base leading-none">›</span> Skip Intro
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
        <ShellNotificationStack>
          <ShellNotificationCard
            className="rounded-lg border border-destructive/20 bg-destructive/10 px-4 py-2 text-xs text-destructive shadow-[0_18px_60px_-24px_rgba(239,68,68,0.58),0_24px_60px_-30px_rgba(0,0,0,0.38)] backdrop-blur-md"
            role="alert"
          >
            {ob.error}
          </ShellNotificationCard>
        </ShellNotificationStack>
      )}
    </div>
    </>
  );
}
