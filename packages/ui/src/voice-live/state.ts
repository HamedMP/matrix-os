import { z } from "zod/v4";

const Text = z.string().max(8_000);
const Id = z.string().min(1).max(200);
const TaskState = z.enum(["queued", "running", "waiting_for_approval", "waiting_for_input", "succeeded", "failed", "cancelled", "timed_out", "outcome_unknown"]);

const ServerFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.ready"), chatId: Id }),
  z.object({ type: z.literal("session.ended"), reason: z.string().max(40) }),
  z.object({ type: z.literal("error"), code: z.string().max(80), retryable: z.boolean() }),
  z.object({ type: z.literal("companion.caption"), speaker: z.enum(["user", "assistant"]), turnId: Id, text: Text, final: z.boolean(), interrupted: z.boolean() }),
  z.object({ type: z.literal("companion.response.started"), responseId: Id }),
  z.object({ type: z.literal("companion.capture.completed"), turnId: Id }),
  z.object({ type: z.literal("companion.task"), chatId: Id, runId: Id, state: TaskState, label: z.string().max(160) }),
  z.object({ type: z.literal("companion.sources"), sources: z.array(z.object({ chatId: Id, title: z.string().max(160), snippet: z.string().max(1600) })).max(5) }),
  z.object({ type: z.literal("response.audio"), responseId: Id, segmentId: Id, startMs: z.number(), data: z.string().max(400_000) }),
  z.object({ type: z.literal("response.audio_end"), responseId: Id }),
  z.object({ type: z.literal("response.interrupted"), responseId: Id }),
]);

export type VoiceLiveServerFrame = z.infer<typeof ServerFrameSchema>;
export type VoiceLiveTask = Extract<VoiceLiveServerFrame, { type: "companion.task" }> extends infer T
  ? T extends { type: string } ? Omit<T, "type"> : never : never;
export type VoiceLiveEvent = VoiceLiveServerFrame | { type: "playback.idle" } | { type: "socket.closed" } | { type: "reset" };

export interface VoiceLiveState {
  status: "connecting" | "listening" | "speaking" | "ended" | "error";
  chatId: string | null;
  userCaption: string;
  assistantCaption: string;
  tasks: VoiceLiveTask[];
  errorCode: string | null;
  endReason: string | null;
}

export const initialVoiceLiveState: VoiceLiveState = {
  status: "connecting", chatId: null, userCaption: "", assistantCaption: "", tasks: [], errorCode: null, endReason: null,
};

export function parseVoiceLiveFrame(raw: string): VoiceLiveServerFrame | null {
  try {
    const parsed = ServerFrameSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

const done = (state: VoiceLiveState) => state.status === "ended" || state.status === "error";

export function reduceVoiceLive(state: VoiceLiveState, event: VoiceLiveEvent): VoiceLiveState {
  if (event.type === "reset") return initialVoiceLiveState;
  if (done(state) && event.type !== "session.ready") return state;
  switch (event.type) {
    case "session.ready":
      return { ...initialVoiceLiveState, status: "listening", chatId: event.chatId };
    case "companion.caption":
      return event.speaker === "user" ? { ...state, userCaption: event.text } : { ...state, assistantCaption: event.text };
    case "companion.response.started":
    case "response.audio":
      return state.status === "speaking" ? state : { ...state, status: "speaking" };
    case "response.interrupted":
    case "playback.idle":
      return state.status === "speaking" ? { ...state, status: "listening" } : state;
    case "companion.task": {
      const { type: _type, ...task } = event;
      const index = state.tasks.findIndex(existing => existing.chatId === task.chatId);
      const tasks = index < 0 ? [...state.tasks, task].slice(-3) : state.tasks.map((existing, i) => i === index ? task : existing);
      return { ...state, tasks };
    }
    case "session.ended":
      return { ...state, status: "ended", endReason: event.reason };
    case "socket.closed":
      return { ...state, status: "ended", endReason: state.endReason ?? "socket_closed" };
    case "error":
      return { ...state, status: "error", errorCode: event.code };
    default:
      return state;
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  provider_unavailable: "The voice service is unavailable right now. Try again in a moment.",
  connection_lost: "The voice connection dropped. Try again.",
  chat_unavailable: "That chat is not available for voice.",
  session_limit_reached: "Voice is busy. Try again in a moment.",
  voice_unavailable: "Voice is not set up on this computer yet.",
  unauthorized: "Sign in again to use voice.",
  audio_backpressure: "Audio fell behind. Try again.",
  microphone_denied: "Microphone access is blocked. Allow microphone access and try again.",
};

export function voiceLiveErrorMessage(code: string | null): string {
  return (code && ERROR_MESSAGES[code]) || "Voice stopped unexpectedly. Try again.";
}
