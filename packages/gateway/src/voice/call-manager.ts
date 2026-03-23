import { randomUUID } from "node:crypto";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  type CallRecord,
  type CallState,
  type NormalizedEvent,
  type VoiceConfig,
  type CallMode,
  CallStateSchema,
  TerminalStates,
  isValidTransition,
} from "./types.js";

export type InitiateCallOptions = {
  from: string;
  webhookUrl: string;
  mode: CallMode;
  greeting?: string;
  onResponse?: (
    callId: string,
    userMessage: string,
    transcript: CallRecord["transcript"],
  ) => Promise<string>;
  metadata?: Record<string, unknown>;
};

type CallTimers = {
  maxDuration?: ReturnType<typeof setTimeout>;
  silence?: ReturnType<typeof setTimeout>;
  eviction?: ReturnType<typeof setTimeout>;
};

export class CallManager {
  private provider: VoiceCallProvider | null = null;
  private config: VoiceConfig | null = null;
  private activeCalls: Map<string, CallRecord> = new Map();
  private providerCallIdMap: Map<string, string> = new Map();
  private timers: Map<string, CallTimers> = new Map();
  private callOptions: Map<string, InitiateCallOptions> = new Map();
  private speechInFlight: Set<string> = new Set();
  private processedEvents: Map<string, Set<string>> = new Map();
  private destroyed = false;

  initialize(provider: VoiceCallProvider, config: VoiceConfig): void {
    this.provider = provider;
    this.config = config;
  }

  async initiateCall(
    to: string,
    options: InitiateCallOptions,
  ): Promise<CallRecord> {
    if (!this.provider || !this.config) {
      throw new Error("CallManager not initialized");
    }

    const maxConcurrent = this.config.telephony.maxConcurrentCalls;
    const currentActive = this.getActiveCalls().length;
    if (currentActive >= maxConcurrent) {
      throw new Error(
        `Max concurrent calls reached (${maxConcurrent}). Cannot initiate new call.`,
      );
    }

    const callId = `call-${randomUUID()}`;

    const result = await this.provider.initiateCall({
      callId,
      from: options.from,
      to,
      webhookUrl: options.webhookUrl,
    });

    const record: CallRecord = {
      callId,
      providerCallId: result.providerCallId,
      provider: this.provider.name,
      direction: "outbound",
      state: "initiated",
      from: options.from,
      to,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      mode: options.mode,
      metadata: options.metadata,
    };

    this.activeCalls.set(callId, record);
    this.providerCallIdMap.set(result.providerCallId, callId);
    this.callOptions.set(callId, options);

    return record;
  }

  processEvent(callId: string, event: NormalizedEvent): void {
    const call = this.activeCalls.get(callId);
    if (!call) {
      throw new Error(`Call not found: ${callId}`);
    }

    let seenIds = this.processedEvents.get(callId);
    if (!seenIds) {
      seenIds = new Set(call.processedEventIds);
      this.processedEvents.set(callId, seenIds);
    }
    if (seenIds.has(event.id)) {
      return;
    }

    const targetState = this.eventToState(event);
    if (targetState && targetState !== call.state) {
      if (!isValidTransition(call.state, targetState)) {
        throw new Error(
          `Invalid transition from '${call.state}' to '${targetState}' for call ${callId}`,
        );
      }
      call.state = targetState;
    }

    if (event.type === "call.answered") {
      call.answeredAt = Date.now();
      this.handleAnswered(callId, call);
    }

    if (event.type === "call.active") {
      this.startMaxDurationTimer(callId);
    }

    if (event.type === "call.speaking" && "text" in event) {
      call.transcript.push({
        speaker: "bot",
        text: event.text,
        ts: event.timestamp,
      });
    }

    if (event.type === "call.speech" && "transcript" in event) {
      call.transcript.push({
        speaker: "user",
        text: event.transcript,
        ts: event.timestamp,
      });
      this.handleSpeech(callId, call, event.transcript);
    }

    if (event.type === "call.ended" && "reason" in event) {
      call.endedAt = Date.now();
      call.endReason = event.reason;
      this.clearTimers(callId);
    }

    if (event.type === "call.error") {
      call.endedAt = Date.now();
      call.endReason = "error";
      this.clearTimers(callId);
    }

    if (TerminalStates.has(call.state)) {
      this.scheduleEviction(callId);
    }

    seenIds.add(event.id);
    call.processedEventIds.push(event.id);
  }

  getCall(callId: string): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    const callId = this.providerCallIdMap.get(providerCallId);
    if (!callId) return undefined;
    return this.activeCalls.get(callId);
  }

  getCallIdByProviderCallId(providerCallId: string): string | undefined {
    return this.providerCallIdMap.get(providerCallId);
  }

  getActiveCalls(): CallRecord[] {
    const results: CallRecord[] = [];
    for (const call of this.activeCalls.values()) {
      if (!TerminalStates.has(call.state)) {
        results.push(call);
      }
    }
    return results;
  }

  async endCall(callId: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      throw new Error(`Call not found: ${callId}`);
    }
    if (!this.provider) {
      throw new Error("CallManager not initialized");
    }

    await this.provider.hangupCall({
      callId,
      providerCallId: call.providerCallId ?? "",
      reason: "hangup-bot",
    });

    this.processEvent(callId, {
      id: `hangup-${randomUUID()}`,
      callId,
      timestamp: Date.now(),
      type: "call.ended",
      reason: "hangup-bot",
    });
  }

  async speak(callId: string, text: string): Promise<void> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      throw new Error(`Call not found: ${callId}`);
    }
    if (!this.provider) {
      throw new Error("CallManager not initialized");
    }

    await this.provider.playTts({
      callId,
      providerCallId: call.providerCallId ?? "",
      text,
    });
  }

  destroy(): void {
    this.destroyed = true;
    for (const [, timers] of this.timers) {
      if (timers.maxDuration) clearTimeout(timers.maxDuration);
      if (timers.silence) clearTimeout(timers.silence);
      if (timers.eviction) clearTimeout(timers.eviction);
    }
    this.timers.clear();
    this.activeCalls.clear();
    this.providerCallIdMap.clear();
    this.callOptions.clear();
    this.speechInFlight.clear();
    this.processedEvents.clear();
  }

  private eventToState(event: NormalizedEvent): CallState | null {
    switch (event.type) {
      case "call.initiated":
        return "initiated";
      case "call.ringing":
        return "ringing";
      case "call.answered":
        return "answered";
      case "call.active":
        return "active";
      case "call.speaking":
        return "speaking";
      case "call.speech":
        return "listening";
      case "call.ended": {
        const reason = (event as { reason: string }).reason;
        const parsed = CallStateSchema.safeParse(reason);
        return parsed.success ? parsed.data : "error";
      }
      case "call.error":
        return "error";
      case "call.silence":
        return null;
      case "call.dtmf":
        return null;
      default:
        return null;
    }
  }

  private handleAnswered(callId: string, call: CallRecord): void {
    const options = this.callOptions.get(callId);
    if (!options) return;

    if (call.mode === "notify" && options.greeting) {
      // In notify mode, play the greeting then schedule hangup
      void this.playNotifyGreeting(callId, call, options.greeting);
    }
  }

  private async playNotifyGreeting(
    callId: string,
    call: CallRecord,
    greeting: string,
  ): Promise<void> {
    if (!this.provider) return;

    try {
      await this.provider.playTts({
        callId,
        providerCallId: call.providerCallId ?? "",
        text: greeting,
      });
    } catch {
      // Greeting delivery is best-effort
    }
  }

  private handleSpeech(
    callId: string,
    call: CallRecord,
    userMessage: string,
  ): void {
    if (this.destroyed || call.mode !== "conversation") return;

    const options = this.callOptions.get(callId);
    if (!options?.onResponse) return;

    if (this.speechInFlight.has(callId)) return;
    this.speechInFlight.add(callId);

    void options
      .onResponse(callId, userMessage, call.transcript)
      .then(async (response) => {
        if (response && !TerminalStates.has(call.state)) {
          await this.speak(callId, response);
        }
      })
      .catch(() => {
        // Response generation failed, continue listening
      })
      .finally(() => {
        this.speechInFlight.delete(callId);
      });
  }

  private startMaxDurationTimer(callId: string): void {
    if (!this.config) return;

    const existing = this.timers.get(callId) ?? {};
    if (existing.maxDuration) return;

    const maxDurationMs = this.config.telephony.maxDurationSeconds * 1000;
    existing.maxDuration = setTimeout(() => {
      const call = this.activeCalls.get(callId);
      if (call && !TerminalStates.has(call.state)) {
        this.processEvent(callId, {
          id: `timeout-${randomUUID()}`,
          callId,
          timestamp: Date.now(),
          type: "call.ended",
          reason: "timeout",
        });
      }
    }, maxDurationMs);

    this.timers.set(callId, existing);
  }

  private scheduleEviction(callId: string): void {
    const existing = this.timers.get(callId) ?? {};
    if (existing.eviction) return;
    existing.eviction = setTimeout(() => {
      this.activeCalls.delete(callId);
      this.callOptions.delete(callId);
      const provId = [...this.providerCallIdMap.entries()].find(
        ([, id]) => id === callId,
      )?.[0];
      if (provId) this.providerCallIdMap.delete(provId);
      this.timers.delete(callId);
    }, 5 * 60_000);
    this.timers.set(callId, existing);
  }

  private clearTimers(callId: string): void {
    const timers = this.timers.get(callId);
    if (timers) {
      if (timers.maxDuration) clearTimeout(timers.maxDuration);
      if (timers.silence) clearTimeout(timers.silence);
      // Do not clear eviction timer — it should fire after terminal state
      if (!timers.eviction) {
        this.timers.delete(callId);
      } else {
        timers.maxDuration = undefined;
        timers.silence = undefined;
      }
    }
  }
}
