import { z } from "zod/v4";
import { VoiceAudioFrameDataSchema, type CanonicalOperationState } from "@matrix-os/contracts/voice-session";
import type { VoiceTurnAdmissionResult } from "../voice-session/ports.js";
import type { ServerFramePayload } from "../voice-session/session-runtime.js";

export interface LiveCompanionPort {
  journal(input: { id: string; role: "user" | "assistant"; text: string; heard?: boolean; playedThroughMs?: number }): Promise<{ messageId: string }>;
  delegate(input: { sourceId: string; kind: "build_app" | "task" | "open_app" | "terminal"; prompt: string }): Promise<VoiceTurnAdmissionResult & { chatId?: string; state?: CanonicalOperationState }>;
  search(query: string): Promise<Array<{ chatId: string; title: string; snippet: string }>>;
  restore(): Promise<Array<{ role: "user" | "assistant"; text: string }>>;
  status(): Promise<{ state: string }>;
  watchTask?(chatId: string, listener: (event: import("../voice-session/ports.js").VoiceCanonicalChatEvent) => void): () => void;
  resumeTasks?(): Promise<Array<{ chatId: string; runId: string; state: import("@matrix-os/contracts/voice-session").CanonicalOperationState; label: string }>>;
}
const TaskSchema = z.object({
  kind: z.enum(["build_app", "task", "open_app", "terminal"]),
  prompt: z.string().trim().min(1).max(4000),
}).strict();
const SearchSchema = z.object({ query: z.string().trim().min(1).max(160) }).strict();
const MAX_TEXT_BYTES = 32_000;
const OUTPUT_FORMAT = { codec: "pcm_s16le" as const, sampleRateHz: 24_000 as const, channels: 1 as const };

/** Native speech owns conversation; canonical Chat alone owns history and task effects.
 * No raw audio or second model pipeline is persisted here. All session maps are
 * bounded; durable admission is responsible for replay after a process restart.
 */
export function createLiveCompanion(options: {
  port: LiveCompanionPort;
  chatId: string;
  emit(frame: ServerFramePayload): void;
  reply(callId: string, result: Record<string, unknown>, name: string): void;
  restoreContext(turns: Array<{ role: "user" | "assistant"; text: string }>): void;
  id(prefix: string): string;
  captureTurnId?(): string | null;
}) {
  let input: { id: string; text: string; messageId?: string; overflow: boolean; finished: boolean } | null = null;
  let response: { id: string; text: string; bytes: number; durationMs: number; ended: boolean; segments: Array<{ id: string; durationMs: number; played: boolean }> } | null = null;
  let closed = false;
  let rejectedInput = false;
  let poisoned = false;
  const tasks = new Map<string, ReturnType<LiveCompanionPort["delegate"]>>(); // at most 3 in-flight admissions; durable broker owns replay and current state
  const fail = () => { poisoned = true; options.emit({ type: "session.error", code: "session_limit_reached", retryable: false, recovery: "continue_in_chat" }); };
  const ensureResponse = async () => {
    if (response?.ended) await live.interrupt();
    if (!response) {
      response = { id: options.id("vresp"), text: "", bytes: 0, durationMs: 0, ended: false, segments: [] };
      options.emit({ type: "companion.response.started", responseId: response.id });
    }
    return response;
  };
  const finalizeInput = async () => {
    const current = input;
    if (!current || !current.text.trim() || current.overflow || rejectedInput) return null;
    if (!current.messageId) {
      const saved = await options.port.journal({ id: current.id, role: "user", text: current.text });
      current.messageId = saved.messageId;
    }
    if (!closed) options.emit({ type: "companion.caption", speaker: "user", turnId: current.id, text: current.text, final: true, interrupted: false });
    return current.messageId;
  };
  const finishResponse = async (heard: boolean) => {
    const current = response;
    if (!current) return;
    response = null;
    const playedThroughMs = current.segments.filter(s => s.played).reduce((total, s) => total + s.durationMs, 0);
    if (current.text.trim()) await options.port.journal({ id: current.id, role: "assistant", text: current.text, heard,
      ...(!heard && playedThroughMs > 0 ? { playedThroughMs } : {}) });
    options.emit({ type: "companion.caption", speaker: "assistant", turnId: current.id, text: current.text || "…", final: true, interrupted: !heard });
  };
  const live = {
    async restore() {
      const turns = await options.port.restore();
      options.restoreContext(turns);
    },
    async input(turnId: string, text: string, finished = false) {
      if (closed || poisoned) return;
      if (!input || input.id !== turnId) {
        if (input) await finalizeInput();
        input = { id: turnId, text: "", overflow: false, finished: false };
        rejectedInput = false;
      }
      // Input after a task finalization belongs to a new utterance, never
      // silently append it to a source whose effect was already admitted.
      if (input.messageId) { rejectedInput = true; return; }
      if (Buffer.byteLength(input.text + text) > MAX_TEXT_BYTES || (input.text + text).length > 8000) { input.overflow = true; fail(); return; }
      input.text += text;
      input.finished = finished;
      options.emit({ type: "companion.caption", speaker: "user", turnId: input.id, text: input.text, final: false, interrupted: false });
    },
    async output(text: string) {
      if (closed || poisoned) return;
      const current = await ensureResponse();
      if (Buffer.byteLength(current.text + text) > MAX_TEXT_BYTES || (current.text + text).length > 8000) { fail(); return; }
      current.text += text;
      options.emit({ type: "companion.caption", speaker: "assistant", turnId: current.id, text: current.text, final: false, interrupted: false });
    },
    async audio(data: string) {
      if (closed || poisoned) return;
      const parsed = VoiceAudioFrameDataSchema.safeParse(data);
      if (!parsed.success || Buffer.from(data, "base64").length % 2 !== 0) { fail(); return; }
      const current = await ensureResponse();
      const bytes = Buffer.from(data, "base64").length;
      if (current.bytes + bytes > 256 * 1024 || current.segments.length >= 512) { fail(); return; }
      const durationMs = bytes / 48;
      const segment = { id: options.id("vseg"), durationMs, played: false };
      current.segments.push(segment);
      current.bytes += bytes;
      options.emit({ type: "response.audio", responseId: current.id, segmentId: segment.id, startMs: Math.floor(current.durationMs), data, format: OUTPUT_FORMAT });
      current.durationMs += durationMs;
    },
    async complete() {
      if (closed) return;
      if (poisoned) { await live.interrupt(); return; }
      await finalizeInput();
      if (input) options.emit({ type: "companion.capture.completed", turnId: options.captureTurnId?.() ?? input.id });
      input = null;
      if (!response) return;
      response.ended = true;
      options.emit({ type: "response.audio_end", responseId: response.id, generatedDurationMs: Math.ceil(response.durationMs) });
      if (response.segments.length === 0) await finishResponse(false);
      else if (response.segments.every(s => s.played)) await finishResponse(true);
    },
    async played(responseId: string, segmentId: string) {
      if (!response || response.id !== responseId || closed) return;
      const index = response.segments.findIndex(s => s.id === segmentId);
      if (index < 0 || response.segments.slice(0, index).some(s => !s.played)) return;
      const segment = response.segments[index]!;
      if (segment.played) return;
      segment.played = true;
      response.bytes = Math.max(0, response.bytes - Math.ceil(segment.durationMs * 48));
      if (response.ended && response.segments.every(s => s.played)) await finishResponse(true);
    },
    async interrupt() {
      if (closed) return;
      if (response) {
        const id = response.id;
        const played = response.segments.filter(s => s.played).reduce((total, s) => total + s.durationMs, 0);
        await finishResponse(false);
        options.emit({ type: "response.interrupted", responseId: id, effectiveThroughMs: Math.floor(played) });
      }
    },
    async tool(callId: string, name: string, args: unknown) {
      if (closed || poisoned || !/^[A-Za-z0-9_.:-]{1,128}$/.test(callId)) return;
      const reply = (result: Record<string, unknown>) => options.reply(callId, result, name);
      try {
        if (name === "find_chats") {
          const query = SearchSchema.parse(args).query;
          const sources = await options.port.search(query);
          options.emit({ type: "companion.sources", sources });
          reply({ sources });
          return;
        }
        if (name === "remember") { reply({ status: "unavailable", message: "Memory coming soon. Use chat retrieval for now." }); return; }
        if (name === "check_task") { reply(await options.port.status()); return; }
        if (name !== "delegate_task") throw new Error("Unsupported voice tool");
        const request = TaskSchema.parse(args);
        // A function call or the model's response boundary is not proof that
        // the independently streamed user transcription has finished.
        if (!input?.finished) { reply({ status: "not_accepted", message: "The user's transcription is unfinished. Wait for its completion before trying again." }); return; }
        const taskLabel = input?.text.slice(0, 160) || "Chat task";
        const sourceId = await finalizeInput();
        if (!sourceId) { reply({ status: "not_accepted", message: "Ask the user to finish the request." }); return; }
        // Semantic identity binds one action category to one final utterance,
        // independent of provider retries which may use new call ids.
        const key = `${sourceId}:${request.kind}`;
        let result = tasks.get(key);
        if (!result) {
          if (tasks.size >= 3) { reply({ status: "not_accepted", message: "Follow existing tasks in Chat before starting more work." }); return; }
          result = options.port.delegate({ sourceId, ...request });
          tasks.set(key, result);
          const clear = () => { if (tasks.get(key) === result) tasks.delete(key); };
          void result.then(clear, clear); // the original rejection is reported below
        }
        const admitted = await result;
        if (admitted.chatId && admitted.runId && admitted.state) options.emit({ type: "companion.task", chatId: admitted.chatId, runId: admitted.runId, state: admitted.state, label: taskLabel });
        reply({ status: admitted.outcome, ...(admitted.state ? { state: admitted.state } : {}), chatId: admitted.chatId ?? options.chatId, ...(admitted.runId ? { runId: admitted.runId } : {}), ...(admitted.canonicalQueuedTurnId ? { queuedTurnId: admitted.canonicalQueuedTurnId } : {}), message: "Report the verified state exactly, including failure or cancellation. Do not infer app readiness." });
      } catch (error: unknown) {
        console.warn("[live-companion] tool failed", error instanceof Error ? error.name : "UnknownError");
        reply({ status: "not_accepted", message: "The request could not be accepted. Continue in Chat." });
      }
    },
    async close() {
      if (closed) return;
      await live.interrupt();
      await finalizeInput();
      closed = true;
      tasks.clear();
      input = null;
    },
  };
  return live;
}
export type LiveCompanion = ReturnType<typeof createLiveCompanion>;
