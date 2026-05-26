"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useOnboarding } from "@/hooks/useOnboarding";
import { useAgentCredentialStatus } from "@/hooks/useAgentCredentialStatus";
import { useIntegrationCapabilities } from "@/hooks/useIntegrationCapabilities";
import { useMicPermission } from "@/hooks/useMicPermission";
import { VoiceWave } from "./onboarding/VoiceWave";
import { ApiKeyInput } from "./onboarding/ApiKeyInput";
import { BrandFrame } from "./onboarding/BrandFrame";
import { CapabilityIntro } from "./onboarding/CapabilityIntro";
import { GoalSelector } from "./onboarding/GoalSelector";
import { ReadinessChecklist } from "./onboarding/ReadinessChecklist";
import { CodingSetupPanel } from "./onboarding/CodingSetupPanel";
import { CodingHandoffSummary } from "./onboarding/CodingHandoffSummary";
import { AgentCredentialPanel } from "./onboarding/AgentCredentialPanel";
import { AssistantSetupPanel } from "./onboarding/AssistantSetupPanel";
import { MicPermissionDialog } from "./MicPermissionDialog";
import { KeyboardIcon, MicIcon, SparklesIcon } from "lucide-react";
import { MATRIX_ONBOARDING_BRAND_VERSION } from "@/lib/onboarding-brand";

const SHIMMER_GRADIENT =
  "linear-gradient(90deg, #2F392C 0%, #2F392C 24%, #C4A265 50%, #2F392C 76%, #2F392C 100%)";
const SHIMMER_ANIMATION =
  "onboard-shimmer 8s ease-in-out infinite, onboard-glow 8s ease-in-out infinite";

interface OnboardingScreenProps {
  onComplete: () => void;
  onOpenTerminal: (path?: string) => void;
}

export function OnboardingScreen({ onComplete, onOpenTerminal }: OnboardingScreenProps) {
  const ob = useOnboarding();
  const agentCredentials = useAgentCredentialStatus();
  const integrationCapabilities = useIntegrationCapabilities();
  const mic = useMicPermission();
  const [started, setStarted] = useState(false);
  const [phase, setPhase] = useState<"idle" | "dimming" | "black" | "revealing">("idle");
  const [showMicDialog, setShowMicDialog] = useState(false);
  const [showSetupDetails, setShowSetupDetails] = useState(false);
  const [showModePicker, setShowModePicker] = useState(false);
  const [splitVisible, setSplitVisible] = useState(false);
  const [continueExiting, setContinueExiting] = useState(false);
  const [entranceStage, setEntranceStage] = useState<"hidden" | "center" | "settled">("hidden");
  const [logoMediaAvailable, setLogoMediaAvailable] = useState(true);
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

  useEffect(() => {
    const image = new Image();
    image.onload = () => setLogoMediaAvailable(true);
    image.onerror = () => setLogoMediaAvailable(false);
    image.src = "/matrix-logo.svg";
    return () => {
      image.onload = null;
      image.onerror = null;
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

  function handleStart(useVoice: boolean) {
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
  }

  const handleTalkToMe = useCallback(async () => {
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
  }, [mic.state, mic.requestAccess]);

  const handleMicAllow = useCallback(async () => {
    const granted = await mic.requestAccess();
    setShowMicDialog(false);
    if (granted) {
      handleStart(true);
    }
  }, [mic.requestAccess]);

  const handleContinue = useCallback(() => {
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
  }, []);

  // ── Voice conversation screen (editorial style) ─────────────
  const isConversing = ob.stage === "greeting" || ob.stage === "interview" || ob.stage === "connecting";
  const codingSelected = ob.selectedGoalIds.includes("coding");
  const assistantSelected = ob.selectedGoalIds.includes("assistant");

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
      <div className="fixed inset-0 z-[60] flex flex-col bg-background">
        <MicPermissionDialog
          open={showMicDialog}
          permissionState={mic.state}
          onAllow={handleMicAllow}
          onDismiss={() => setShowMicDialog(false)}
        />

        {showSetupDetails ? (
          <BrandFrame mediaAvailable={logoMediaAvailable}>
            <div className="space-y-5">
              <CapabilityIntro />
              <div className="grid gap-4 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[#111612]">Choose your first goal</h2>
                    <span className="text-xs text-[#17281f]/55">You can change this later</span>
                  </div>
                  <GoalSelector selectedGoalIds={ob.selectedGoalIds} onSelect={ob.selectGoal} />
                </div>
                <div>
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[#111612]">Readiness</h2>
                    <span className="text-xs capitalize text-[#17281f]/55">{ob.readiness?.overallStatus ?? "checking"}</span>
                  </div>
                  <ReadinessChecklist gates={ob.readiness?.gates ?? []} />
                </div>
              </div>

              {ob.onboardingSteps.length > 0 && (
                <div className="rounded-md border border-[#17281f]/10 bg-[#17281f]/5 p-3">
                  <h2 className="text-sm font-semibold text-[#111612]">Setup path</h2>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {ob.onboardingSteps.map((step) => (
                      <span key={step.id} className="rounded-full border border-[#17281f]/10 bg-white/55 px-3 py-1 text-xs text-[#17281f]/70">
                        {step.required ? "Required" : "Optional"} · {step.title}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {codingSelected && (
                <div className="grid gap-3">
                  <CodingSetupPanel gates={ob.readiness?.gates ?? []} onOpenTerminal={onOpenTerminal} />
                  <CodingHandoffSummary
                    activeAgents={ob.readiness?.activeAgents ?? ["hermes"]}
                    status={ob.readiness?.codingHandoffStatus ?? null}
                  />
                </div>
              )}

              <AgentCredentialPanel status={agentCredentials.status} error={agentCredentials.error} onVerify={agentCredentials.verify} />

              {assistantSelected && (
                <AssistantSetupPanel
                  capabilities={integrationCapabilities.capabilities}
                  error={integrationCapabilities.error}
                  onApprove={integrationCapabilities.approveForHermes}
                />
              )}

              <div className="flex flex-col gap-2 sm:flex-row">
                <button
                  onClick={() => setShowSetupDetails(false)}
                  disabled={phase !== "idle" || started}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md border border-[#17281f]/15 bg-white/55 px-4 text-sm font-medium text-[#17281f] transition hover:border-[#17281f]/30 disabled:opacity-55"
                >
                  Back to choices
                </button>
                <button
                  onClick={() => handleStart(false)}
                  disabled={phase !== "idle" || started}
                  className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-[#17281f] px-4 text-sm font-medium text-[#f4f0e8] transition hover:bg-[#23382c] disabled:opacity-55"
                >
                  <KeyboardIcon className="h-4 w-4" aria-hidden="true" />
                  Continue with text
                </button>
              </div>
            </div>
          </BrandFrame>
        ) : (
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
                  transition: "transform 1.5s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
              >
                <div
                  role="img"
                  aria-label="Matrix OS logo"
                  className="h-[132px] w-[124px] sm:h-[156px] sm:w-[148px]"
                  style={{
                    WebkitMaskImage: "url('/matrix-logo.svg')",
                    WebkitMaskRepeat: "no-repeat",
                    WebkitMaskSize: "contain",
                    WebkitMaskPosition: "center",
                    maskImage: "url('/matrix-logo.svg')",
                    maskRepeat: "no-repeat",
                    maskSize: "contain",
                    maskPosition: "center",
                    backgroundImage: SHIMMER_GRADIENT,
                    backgroundSize: "300% 100%",
                    animation: phase === "idle" ? SHIMMER_ANIMATION : "none",
                    opacity: entranceStage === "hidden" || phase === "black" ? 0 : 1,
                    transform: entranceStage !== "settled"
                      ? "translateY(28vh) scale(1.5)"
                      : phase === "dimming"
                        ? "translateY(-20px) scale(1.05)"
                        : "translateY(0) scale(1)",
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
                className="relative flex w-full max-w-4xl justify-center"
                style={{
                  minHeight: "12rem",
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

                <div className="grid w-full items-stretch gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
                  {[
                    {
                      label: "Talk to Aoede",
                      description: "Let voice guide the first setup and explain what Matrix can do.",
                      icon: MicIcon,
                      onClick: handleTalkToMe,
                    },
                    {
                      label: "Set up manually",
                      description: "Choose the first outcome, connect tools, and review every step.",
                      icon: SparklesIcon,
                      onClick: () => setShowSetupDetails(true),
                    },
                    {
                      label: "Enter workspace",
                      description: "Open Matrix now. Hermes stays active and optional setup remains available.",
                      icon: KeyboardIcon,
                      onClick: () => {
                        onOpenTerminal();
                        onComplete();
                      },
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
                        className={`${gridColumn} group flex min-h-[10rem] flex-col justify-center rounded-md border border-transparent px-5 py-4 text-left text-[#2f392c] transition hover:border-[#c4a265]/30 hover:bg-[#c4a265]/10 disabled:pointer-events-none md:px-6`}
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
              onClick={() => {
                onOpenTerminal();
                onComplete();
              }}
              className="relative z-10 mx-auto mb-7 text-xs text-[#2f392c]/40 transition hover:text-[#2f392c]/70"
              style={{ opacity: phase === "idle" ? 1 : 0 }}
            >
              Skip first-time setup
            </button>
          </section>
        )}

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

          {/* Voice wave — full width, below transcript */}
          <div className="absolute inset-x-0 bottom-[8%] h-[160px]">
            <VoiceWave state={ob.voiceState} />
          </div>

          {/* Skip intro — bottom */}
          <button
            onClick={() => {
              ob.chooseClaudeCode();
              onOpenTerminal();
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
