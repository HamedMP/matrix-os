import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookParseOptions,
  WebhookVerificationResult,
} from "../types.js";

export interface VoiceCallProvider {
  readonly name: ProviderName;

  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  parseWebhookEvent(
    ctx: WebhookContext,
    options?: WebhookParseOptions,
  ): ProviderWebhookParseResult;

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  hangupCall(input: HangupCallInput): Promise<void>;

  playTts(input: PlayTtsInput): Promise<void>;

  startListening(input: StartListeningInput): Promise<void>;

  stopListening(input: StopListeningInput): Promise<void>;

  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}
