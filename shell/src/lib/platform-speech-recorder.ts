import {
  createWebPcmSpeechCaptureAdapter as createSharedWebPcmSpeechCaptureAdapter,
  encodePcm16Wav,
  PlatformSpeechRecorderError,
  type PlatformSpeechCaptureAdapter,
} from "@matrix-os/ui";
import { getGatewayUrl } from "./gateway.js";

const WORKLET_ASSET_PATH = "/speech-pcm-capture-worklet.js";

export { encodePcm16Wav, PlatformSpeechRecorderError };

export function resolveSpeechWorkletUrl(): string {
  return `${getGatewayUrl()}${WORKLET_ASSET_PATH}`;
}

export function createWebPcmSpeechCaptureAdapter(options: {
  workletUrl?: string;
} = {}): PlatformSpeechCaptureAdapter {
  return createSharedWebPcmSpeechCaptureAdapter({
    workletUrl: options.workletUrl ?? resolveSpeechWorkletUrl(),
  });
}
