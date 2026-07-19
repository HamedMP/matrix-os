"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { buildAuthenticatedWebSocketUrl } from "@/lib/websocket-auth";

export type OnboardingStage =
  | "connecting"
  | "greeting"
  | "interview"
  | "extract_profile"
  | "suggest_apps"
  | "api_key"
  | "done";

export type VoiceState = "idle" | "listening" | "speaking" | "thinking";
export type OnboardingGoalId = "coding" | "app_building" | "company_brain" | "assistant";

export interface ReadinessGateSummary {
  id: string;
  category: string;
  criticality: "release_critical" | "goal_required" | "recommended" | "optional";
  status: "unknown" | "checking" | "pass" | "fail" | "blocked" | "skipped";
  message: string;
  remediation: string | null;
  owner: "user" | "operator" | "matrix";
  lastCheckedAt: string | null;
  evidence?: string[];
}

export interface OnboardingGoalSummary {
  id: OnboardingGoalId;
  selected: boolean;
  label: string;
  description: string;
}

export interface OnboardingStepSummary {
  id: string;
  required: boolean;
  title: string;
  unlocks: string[];
}

export interface OnboardingReadiness {
  overallStatus: "ready" | "degraded" | "blocked" | "checking";
  goals: OnboardingGoalSummary[];
  gates: ReadinessGateSummary[];
  systemAgent: "hermes";
  activeAgents: Array<"claude" | "codex" | "hermes">;
  codingHandoffStatus: "idle" | "running" | "needs_input" | "ready" | "failed" | null;
}

const READINESS_STATUSES = new Set<ReadinessGateSummary["status"]>(["unknown", "checking", "pass", "fail", "blocked", "skipped"]);
const READINESS_CRITICALITIES = new Set<ReadinessGateSummary["criticality"]>(["release_critical", "goal_required", "recommended", "optional"]);
const READINESS_OWNERS = new Set<ReadinessGateSummary["owner"]>(["user", "operator", "matrix"]);
const READINESS_OVERALL_STATUSES = new Set<OnboardingReadiness["overallStatus"]>(["ready", "degraded", "blocked", "checking"]);
const ONBOARDING_GOAL_IDS = new Set<OnboardingGoalId>(["coding", "app_building", "company_brain", "assistant"]);
const AGENT_IDS = new Set<OnboardingReadiness["activeAgents"][number]>(["claude", "codex", "hermes"]);
const CODING_HANDOFF_STATUSES = new Set<NonNullable<OnboardingReadiness["codingHandoffStatus"]>>(["idle", "running", "needs_input", "ready", "failed"]);

function isOnboardingGoalId(value: unknown): value is OnboardingGoalId {
  return typeof value === "string" && ONBOARDING_GOAL_IDS.has(value as OnboardingGoalId);
}

function coerceGoalIds(value: unknown, fallback: OnboardingGoalId[] = []): OnboardingGoalId[] {
  if (!Array.isArray(value)) return fallback;
  const next = Array.from(new Set(value.filter(isOnboardingGoalId)));
  return next.length > 0 ? next : fallback;
}

function coerceActiveAgents(value: unknown): OnboardingReadiness["activeAgents"] {
  if (!Array.isArray(value)) return ["hermes"];
  const agents = Array.from(new Set(value.filter((agent): agent is OnboardingReadiness["activeAgents"][number] =>
    typeof agent === "string" && AGENT_IDS.has(agent as OnboardingReadiness["activeAgents"][number])
  )));
  return agents.length > 0 ? agents : ["hermes"];
}

export function coerceReadinessOverallStatus(value: unknown): OnboardingReadiness["overallStatus"] {
  return typeof value === "string" && READINESS_OVERALL_STATUSES.has(value as OnboardingReadiness["overallStatus"])
    ? value as OnboardingReadiness["overallStatus"]
    : "degraded";
}

function coerceCodingHandoffStatus(value: unknown): OnboardingReadiness["codingHandoffStatus"] {
  if (typeof value !== "string") return null;
  return CODING_HANDOFF_STATUSES.has(value as NonNullable<OnboardingReadiness["codingHandoffStatus"]>)
    ? value as NonNullable<OnboardingReadiness["codingHandoffStatus"]>
    : null;
}

export function coerceReadinessGates(value: unknown): ReadinessGateSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter((gate): gate is ReadinessGateSummary => {
    if (!gate || typeof gate !== "object") return false;
    const candidate = gate as Partial<ReadinessGateSummary>;
    return typeof candidate.id === "string" &&
      typeof candidate.category === "string" &&
      typeof candidate.message === "string" &&
      (candidate.remediation === null || typeof candidate.remediation === "string") &&
      (candidate.lastCheckedAt === null || typeof candidate.lastCheckedAt === "string") &&
      typeof candidate.status === "string" &&
      READINESS_STATUSES.has(candidate.status as ReadinessGateSummary["status"]) &&
      typeof candidate.criticality === "string" &&
      READINESS_CRITICALITIES.has(candidate.criticality as ReadinessGateSummary["criticality"]) &&
      typeof candidate.owner === "string" &&
      READINESS_OWNERS.has(candidate.owner as ReadinessGateSummary["owner"]);
  });
}

export function coerceReadinessGoals(value: unknown): OnboardingGoalSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter((goal): goal is OnboardingGoalSummary => {
    if (!goal || typeof goal !== "object") return false;
    const candidate = goal as Partial<OnboardingGoalSummary>;
    return isOnboardingGoalId(candidate.id) &&
      typeof candidate.selected === "boolean" &&
      typeof candidate.label === "string" &&
      typeof candidate.description === "string";
  });
}

export function coerceOnboardingSteps(value: unknown): OnboardingStepSummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter((step): step is OnboardingStepSummary => {
    if (!step || typeof step !== "object") return false;
    const candidate = step as Partial<OnboardingStepSummary>;
    return typeof candidate.id === "string" &&
      typeof candidate.required === "boolean" &&
      typeof candidate.title === "string" &&
      Array.isArray(candidate.unlocks) &&
      candidate.unlocks.every((workflow) => typeof workflow === "string");
  });
}

export function coerceReadinessResponse(value: unknown): OnboardingReadiness {
  const candidate = value && typeof value === "object" ? value as Partial<OnboardingReadiness> : {};
  const goals = coerceReadinessGoals(candidate.goals);
  return {
    overallStatus: coerceReadinessOverallStatus(candidate.overallStatus),
    goals,
    gates: coerceReadinessGates(candidate.gates),
    systemAgent: "hermes",
    activeAgents: coerceActiveAgents(candidate.activeAgents),
    codingHandoffStatus: coerceCodingHandoffStatus(candidate.codingHandoffStatus),
  };
}

interface Transcript {
  speaker: "ai" | "user";
  text: string;
}

interface SuggestedApp {
  name: string;
  description: string;
}

export type ContentDisplay =
  | { kind: "app_suggestions"; apps: { name: string; description: string }[] }
  | { kind: "desktop_mockup"; highlights: string[] }
  | { kind: "profile_info"; fields: { name?: string; role?: string; interests?: string[] } }
  | null;

export interface OnboardingHook {
  stage: OnboardingStage;
  voiceState: VoiceState;
  transcripts: Transcript[];
  suggestedApps: SuggestedApp[];
  error: string | null;
  isVoiceMode: boolean;
  alreadyComplete: boolean;
  apiKeyResult: { valid: boolean; error?: string } | null;
  currentSubtitle: string;
  contextualContent: ContentDisplay;
  readiness: OnboardingReadiness | null;
  selectedGoalIds: OnboardingGoalId[];
  onboardingSteps: OnboardingStepSummary[];
  start: (useVoice: boolean) => void;
  sendText: (text: string) => void;
  sendApiKey: (key: string) => void;
  confirmApps: (apps: string[]) => void;
  selectGoal: (goalId: OnboardingGoalId) => void;
  refreshReadiness: () => void;
  chooseClaudeCode: () => void;
  finishInterview: () => void;
}

export function useOnboarding(): OnboardingHook {
  const [stage, setStage] = useState<OnboardingStage>("connecting");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [suggestedApps, setSuggestedApps] = useState<SuggestedApp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isVoiceMode, setIsVoiceMode] = useState(false);
  const [alreadyComplete, setAlreadyComplete] = useState(false);
  const [apiKeyResult, setApiKeyResult] = useState<{ valid: boolean; error?: string } | null>(null);
  const [currentSubtitle, setCurrentSubtitle] = useState("");
  const [contextualContent, setContextualContent] = useState<ContentDisplay>(null);
  const [readiness, setReadiness] = useState<OnboardingReadiness | null>(null);
  const [selectedGoalIds, setSelectedGoalIds] = useState<OnboardingGoalId[]>([]);
  const [onboardingSteps, setOnboardingSteps] = useState<OnboardingStepSummary[]>([]);

  const wsRef = useRef<WebSocket | null>(null);
  const micCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const isPlayingRef = useRef(false);
  const nextStartTimeRef = useRef(0);
  const playGainRef = useRef<GainNode | null>(null);
  const goalSelectionSeqRef = useRef(0);
  const readinessRefreshSeqRef = useRef(0);
  const readinessRef = useRef<OnboardingReadiness | null>(null);
  const pendingActiveAgentsRef = useRef<OnboardingReadiness["activeAgents"] | null>(null);
  // Tracks whether the hook is still mounted so async mic setup can bail
  // out cleanly if the user dismisses onboarding while the mic permission
  // prompt or audioWorklet module load is in flight. Without this, the
  // MediaStream + AudioContext leak past unmount.
  const mountedRef = useRef(false);

  // Word-by-word subtitle reveal queue
  const wordQueueRef = useRef<string[]>([]);
  const revealIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ~3.3 words/sec matches Aoede's speaking cadence at normal pace
  const WORD_REVEAL_MS = 300;

  // Play PCM16 audio (24kHz, mono, s16le) from base64
  // Immediately decodes and schedules each chunk on the Web Audio timeline —
  // no queue, no awaiting. The browser's audio thread handles gapless playback.
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const playAudio = useCallback((base64: string) => {
    // Lazy-init playback context at system default rate (typically 48kHz)
    if (!playCtxRef.current) {
      playCtxRef.current = new AudioContext();
      const g = playCtxRef.current.createGain();
      g.gain.value = 1.0;
      // DynamicsCompressor keeps loud TTS chunks from clipping past [-1, 1]
      // while still feeling present at unity gain.
      const compressor = playCtxRef.current.createDynamicsCompressor();
      compressor.threshold.value = -6;
      compressor.knee.value = 10;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.1;
      g.connect(compressor);
      compressor.connect(playCtxRef.current.destination);
      playGainRef.current = g;
      nextStartTimeRef.current = 0;
    }
    const ctx = playCtxRef.current;
    const gainNode = playGainRef.current!;

    // Decode PCM16 → Float32
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7FFF);
    }

    // Create buffer at source rate (24kHz) — Web Audio upsamples to output rate
    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.copyToChannel(float32, 0);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);

    // Schedule exactly back-to-back — chunks are continuous PCM, no gap needed
    const startAt = Math.max(ctx.currentTime, nextStartTimeRef.current);
    source.start(startAt);
    nextStartTimeRef.current = startAt + buffer.duration;

    // Track speaking state
    if (!isPlayingRef.current) {
      isPlayingRef.current = true;
      setVoiceState("speaking");
    }

    // When this chunk ends, check if it was the last scheduled one
    source.onended = () => {
      if (ctx.currentTime >= nextStartTimeRef.current - 0.05) {
        isPlayingRef.current = false;
        setVoiceState("listening");
      }
    };
  }, []);

  // Word-by-word reveal: pull one word at a time from the queue
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const startWordReveal = useCallback(() => {
    if (revealIntervalRef.current) return; // already running
    revealIntervalRef.current = setInterval(() => {
      const word = wordQueueRef.current.shift();
      if (word) {
        setCurrentSubtitle((prev) => {
          const next = (prev ? prev + " " : "") + word;
          // Trim to last 2 sentences if overflow
          const sentences = next.split(/(?<=[.!?])\s+/);
          return sentences.length > 3 ? sentences.slice(-2).join(" ") : next;
        });
      } else {
        // Queue drained — pause interval until more words arrive
        clearInterval(revealIntervalRef.current!);
        revealIntervalRef.current = null;
      }
    }, WORD_REVEAL_MS);
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const enqueueWords = useCallback((text: string) => {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return;
    wordQueueRef.current.push(...words);
    startWordReveal();
  }, [startWordReveal]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const clearWordReveal = useCallback(() => {
    wordQueueRef.current = [];
    if (revealIntervalRef.current) {
      clearInterval(revealIntervalRef.current);
      revealIntervalRef.current = null;
    }
    setCurrentSubtitle("");
  }, []);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const refreshReadiness = useCallback(() => {
    const requestSeq = readinessRefreshSeqRef.current + 1;
    readinessRefreshSeqRef.current = requestSeq;
    void fetch(`${getGatewayUrl()}/api/onboarding/readiness`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("readiness request failed");
        return coerceReadinessResponse(await res.json());
      })
      .then((next) => {
        if (!mountedRef.current || requestSeq !== readinessRefreshSeqRef.current) return;
        const activeAgents = pendingActiveAgentsRef.current;
        setReadiness(activeAgents ? { ...next, activeAgents } : next);
        setSelectedGoalIds(next.goals.flatMap((goal) => (goal.selected ? [goal.id] : [])));
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] readiness refresh failed:", err instanceof Error ? err.message : String(err));
      });
  }, []);

  useEffect(() => {
    readinessRef.current = readiness;
  }, [readiness]);

  // Send JSON message to gateway
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const send = useCallback((msg: Record<string, unknown>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  // Start mic capture via AudioWorklet
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const startMic = useCallback(async () => {
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      // Bail if the user dismissed onboarding while the permission prompt
      // was open — otherwise the freshly-granted MediaStream leaks past
      // unmount and the OS mic indicator stays on.
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;

      ctx = new AudioContext({ sampleRate: 16000 });
      micCtxRef.current = ctx;

      // react-doctor-disable-next-line react-doctor/async-defer-await -- dependent await, cannot defer: the AudioWorkletNode constructed below requires the "pcm16-processor" module to be fully registered first, and the post-await mountedRef bail-out must run only after the module finishes loading; there is no independent work to interleave before this point.
      await ctx.audioWorklet.addModule("/audio-worklet-processor.js");
      if (!mountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch((err: unknown) => {
          console.warn("[onboarding] failed to close abandoned audio context", err);
        });
        streamRef.current = null;
        micCtxRef.current = null;
        return;
      }
      const worklet = new AudioWorkletNode(ctx, "pcm16-processor");
      workletNodeRef.current = worklet;

      worklet.port.onmessage = (e) => {
        if (e.data.type === "audio" && e.data.bytes) {
          // Convert ArrayBuffer to base64 in main thread (btoa unavailable in worklet)
          const bytes = new Uint8Array(e.data.bytes);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          send({ type: "audio", data: btoa(binary) });
        }
      };

      const source = ctx.createMediaStreamSource(stream);
      source.connect(worklet);
      setVoiceState("listening");
    } catch (err) {
      console.warn("[onboarding] mic initialization failed", err);
      // Stop any stream/context we partially acquired before the error.
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch((closeErr: unknown) => {
        console.warn("[onboarding] failed to close audio context after mic error", closeErr);
      });
      streamRef.current = null;
      micCtxRef.current = null;
      if (mountedRef.current) {
        setIsVoiceMode(false);
      }
      throw err;
    }
  }, [send]);

  // Handle incoming WebSocket messages
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const handleMessage = useCallback((evt: MessageEvent) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(evt.data);
    } catch (err) {
      console.warn("[onboarding] invalid websocket message", err);
      return;
    }

    switch (msg.type) {
      case "stage":
        setStage(msg.stage as OnboardingStage);
        if (msg.apps) setSuggestedApps(msg.apps as SuggestedApp[]);
        if (msg.audioSource === "gemini_live") setVoiceState("listening");
        break;
      case "audio":
        playAudio(msg.data as string);
        break;
      case "transcript": {
        const speaker = msg.speaker as "ai" | "user";
        const text = msg.text as string;
        setTranscripts((prev) => [...prev, { speaker, text }]);

        if (speaker === "ai") {
          // Queue words for gradual reveal synced to voice pace
          enqueueWords(text);
        } else {
          // User is speaking — clear AI subtitle
          clearWordReveal();
        }
        break;
      }
      case "interrupted":
        // User started speaking — kill all scheduled audio instantly
        isPlayingRef.current = false;
        nextStartTimeRef.current = 0;
        if (playCtxRef.current) {
          playCtxRef.current.close();
          playCtxRef.current = null;
          playGainRef.current = null;
        }
        setVoiceState("listening");
        clearWordReveal();
        break;
      case "turn_complete":
        // AI finished speaking — keep subtitle visible until next interaction
        break;
      case "contextual_content": {
        const content = msg.content as NonNullable<ContentDisplay>;
        if (content.kind === "profile_info") {
          // Merge profile fields incrementally
          setContextualContent((prev) => {
            if (prev?.kind === "profile_info") {
              return {
                kind: "profile_info",
                fields: {
                  name: content.fields.name ?? prev.fields.name,
                  role: content.fields.role ?? prev.fields.role,
                  interests: [...new Set([...(prev.fields.interests ?? []), ...(content.fields.interests ?? [])])],
                },
              };
            }
            return content;
          });
        } else {
          setContextualContent(content);
        }
        break;
      }
      case "readiness_update":
        if (!readinessRef.current) {
          refreshReadiness();
          break;
        }
        setReadiness((prev) => {
          const current = prev ?? readinessRef.current;
          if (!current) return prev;
          return {
            overallStatus: coerceReadinessOverallStatus(msg.overallStatus),
            goals: current.goals,
            gates: coerceReadinessGates(msg.checklist),
            systemAgent: current.systemAgent,
            activeAgents: current.activeAgents,
            codingHandoffStatus: current.codingHandoffStatus,
          };
        });
        break;
      case "goal_selected":
        if (!isOnboardingGoalId(msg.goalId)) break;
        const selectedGoalId = msg.goalId;
        readinessRefreshSeqRef.current += 1;
        setSelectedGoalIds((prev) => prev.includes(selectedGoalId) ? prev : [...prev, selectedGoalId]);
        setOnboardingSteps(coerceOnboardingSteps(msg.steps));
        break;
      case "agent_status":
        pendingActiveAgentsRef.current = coerceActiveAgents(msg.activeAgents);
        setReadiness((prev) => prev ? {
          ...prev,
          systemAgent: "hermes",
          activeAgents: pendingActiveAgentsRef.current ?? ["hermes"],
        } : prev);
        break;
      case "mode_change":
        setIsVoiceMode(msg.mode === "voice");
        if (msg.mode === "text") setVoiceState("idle");
        break;
      case "api_key_result":
        setApiKeyResult({ valid: msg.valid as boolean, error: msg.error as string | undefined });
        break;
      case "onboarding_already_complete":
        setAlreadyComplete(true);
        break;
      case "error":
        setError(msg.message as string);
        break;
    }
  }, [playAudio, refreshReadiness, enqueueWords, clearWordReveal]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const connect = useCallback(async (): Promise<WebSocket | null> => {
    // react-doctor-disable-next-line react-doctor/async-defer-await -- dependent await, cannot defer: the resolved wsUrl is the sole input to the `new WebSocket(wsUrl)` below, and the mountedRef bail-out must run after auth resolves so we never open a socket for an unmounted hook; there is no independent work to start before the URL is known.
    const wsUrl = await buildAuthenticatedWebSocketUrl("/ws/onboarding");
    if (!mountedRef.current) return null;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => setStage("connecting");
    ws.onmessage = handleMessage;
    ws.onerror = () => setError("Connection failed");
    ws.onclose = () => {
      wsRef.current = null;
    };

    return ws;
  }, [handleMessage]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    refreshReadiness();
    return () => {
      mountedRef.current = false;
      wsRef.current?.close();
      streamRef.current?.getTracks().forEach((t) => t.stop());
      micCtxRef.current?.close();
      playCtxRef.current?.close();
      if (revealIntervalRef.current) clearInterval(revealIntervalRef.current);
    };
  }, [refreshReadiness]);

  // Public API
  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const start = useCallback((useVoice: boolean) => {
    setIsVoiceMode(useVoice);

    void connect()
      .then((ws) => {
        if (!ws || !mountedRef.current) return;

        // Wait for WS open, then send start message.
        const checkOpen = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            clearInterval(checkOpen);
            if (!useVoice) {
              send({ type: "start", audioFormat: "text" });
              return;
            }
            void startMic()
              .then(() => {
                if (mountedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                  send({ type: "start", audioFormat: "pcm16" });
                }
              })
              .catch((err: unknown) => {
                console.warn("[onboarding] voice mic unavailable, falling back to text:", err instanceof Error ? err.message : String(err));
                if (mountedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
                  setIsVoiceMode(false);
                  send({ type: "start", audioFormat: "text" });
                }
              });
          }
        }, 50);
        setTimeout(() => clearInterval(checkOpen), 5000);
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] connect failed:", err instanceof Error ? err.message : String(err));
        setError("Connection failed");
      });
  }, [connect, send, startMic]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const sendText = useCallback((text: string) => {
    send({ type: "text_input", text });
  }, [send]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const sendApiKey = useCallback((key: string) => {
    setApiKeyResult(null);
    send({ type: "set_api_key", apiKey: key });
  }, [send]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const confirmApps = useCallback((apps: string[]) => {
    send({ type: "confirm_apps", apps });
  }, [send]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const selectGoal = useCallback((goalId: OnboardingGoalId) => {
    const requestSeq = goalSelectionSeqRef.current + 1;
    goalSelectionSeqRef.current = requestSeq;
    const previousGoalIds = selectedGoalIds;
    const nextGoalIds = selectedGoalIds.includes(goalId)
      ? selectedGoalIds.filter((id) => id !== goalId)
      : [...selectedGoalIds, goalId];
    const normalizedGoalIds = nextGoalIds.length > 0 ? nextGoalIds : [goalId];
    readinessRefreshSeqRef.current += 1;
    setSelectedGoalIds(normalizedGoalIds);
    void fetch(`${getGatewayUrl()}/api/onboarding/goals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ goalIds: normalizedGoalIds }),
      signal: AbortSignal.timeout(10_000),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error("goal selection failed");
        return await res.json() as { goalIds?: unknown; steps?: unknown };
      })
      .then((body) => {
        if (!mountedRef.current || requestSeq !== goalSelectionSeqRef.current) return;
        setSelectedGoalIds(coerceGoalIds(body.goalIds, normalizedGoalIds));
        setOnboardingSteps(coerceOnboardingSteps(body.steps));
        refreshReadiness();
      })
      .catch((err: unknown) => {
        console.warn("[onboarding] goal selection failed:", err instanceof Error ? err.message : String(err));
        if (mountedRef.current && requestSeq === goalSelectionSeqRef.current) {
          setSelectedGoalIds(previousGoalIds);
          setError("Could not update setup goal");
        }
      });
  }, [refreshReadiness, selectedGoalIds]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const chooseClaudeCode = useCallback(() => {
    send({ type: "choose_activation", path: "claude_code" });
  }, [send]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const finishInterview = useCallback(() => {
    send({ type: "confirm_apps", apps: [] });
  }, [send]);

  return {
    stage,
    voiceState,
    transcripts,
    suggestedApps,
    error,
    isVoiceMode,
    alreadyComplete,
    apiKeyResult,
    currentSubtitle,
    contextualContent,
    readiness,
    selectedGoalIds,
    onboardingSteps,
    start,
    sendText,
    sendApiKey,
    confirmApps,
    selectGoal,
    refreshReadiness,
    chooseClaudeCode,
    finishInterview,
  };
}
