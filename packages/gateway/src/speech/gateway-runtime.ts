import type { Context, Hono } from "hono";
import type { OwnerAudioTranscriber } from "@matrix-os/kernel";
import type { SttProvider } from "../voice/stt/base.js";
import type { RequestPrincipal } from "../request-principal.js";
import {
  createFfmpegPcmWavConverter,
  createManagedChannelSttProvider,
  createManagedOwnerAudioTranscriber,
} from "./managed-transcriber.js";
import {
  createPlatformSpeechClient,
  loadPlatformSpeechRuntimeConfig,
} from "./platform-client.js";
import { createSpeechGatewayRoutes } from "./routes.js";

interface GatewaySpeechRuntimeOptions {
  env: NodeJS.ProcessEnv;
  getPrincipal(c: Context): RequestPrincipal;
}

export interface GatewaySpeechRuntime {
  routes: Hono;
  ownerAudioTranscriber?: OwnerAudioTranscriber;
  channelStt: SttProvider | null;
}

export function createGatewaySpeechRuntime(
  options: GatewaySpeechRuntimeOptions,
): GatewaySpeechRuntime {
  const runtimeConfig = loadPlatformSpeechRuntimeConfig(options.env);
  const client = runtimeConfig ? createPlatformSpeechClient(runtimeConfig) : undefined;
  const converter = client
    ? createFfmpegPcmWavConverter({
        ...(options.env.MATRIX_SPEECH_FFMPEG_PATH
          ? { ffmpegPath: options.env.MATRIX_SPEECH_FFMPEG_PATH }
          : {}),
      })
    : undefined;

  return {
    routes: createSpeechGatewayRoutes({ client, getPrincipal: options.getPrincipal,
      previewRuntime: options.env.MATRIX_PREVIEW_RUNTIME === "true" }),
    ownerAudioTranscriber: client && converter
      ? createManagedOwnerAudioTranscriber({ client, converter })
      : undefined,
    channelStt: client && converter
      ? createManagedChannelSttProvider({ client, converter })
      : null,
  };
}

export function createGatewaySpeechRuntimeRoutes(
  options: GatewaySpeechRuntimeOptions,
): Hono {
  return createGatewaySpeechRuntime(options).routes;
}
