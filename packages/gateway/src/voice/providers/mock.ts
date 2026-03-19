import { randomUUID } from "node:crypto";
import type { VoiceCallProvider } from "./base.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";

type HistoryEntry = {
  method: string;
  args: Record<string, unknown>;
  timestamp: number;
};

type MockProviderOptions = {
  callStatus?: GetCallStatusResult;
  webhookEvents?: NormalizedEvent[];
};

export class MockProvider implements VoiceCallProvider {
  readonly name = "mock" as const;
  readonly callHistory: HistoryEntry[] = [];

  private callStatus: GetCallStatusResult;
  private webhookEvents: NormalizedEvent[];

  constructor(options?: MockProviderOptions) {
    this.callStatus = options?.callStatus ?? {
      status: "active",
      isTerminal: false,
    };
    this.webhookEvents = options?.webhookEvents ?? [];
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(
    _ctx: WebhookContext,
  ): ProviderWebhookParseResult {
    return { events: this.webhookEvents };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const providerCallId = `mock-${randomUUID()}`;
    this.callHistory.push({
      method: "initiateCall",
      args: { ...input },
      timestamp: Date.now(),
    });
    return { providerCallId, status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    this.callHistory.push({
      method: "hangupCall",
      args: { ...input },
      timestamp: Date.now(),
    });
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    this.callHistory.push({
      method: "playTts",
      args: { ...input },
      timestamp: Date.now(),
    });
  }

  async startListening(input: StartListeningInput): Promise<void> {
    this.callHistory.push({
      method: "startListening",
      args: { ...input },
      timestamp: Date.now(),
    });
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    this.callHistory.push({
      method: "stopListening",
      args: { ...input },
      timestamp: Date.now(),
    });
  }

  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return this.callStatus;
  }
}
