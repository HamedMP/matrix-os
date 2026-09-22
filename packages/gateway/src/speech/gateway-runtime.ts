import type { Context, Hono } from "hono";
import {
  createPlatformSpeechClient,
  loadPlatformSpeechRuntimeConfig,
} from "./platform-client.js";
import { createSpeechGatewayRoutes } from "./routes.js";

export function createGatewaySpeechRuntimeRoutes(options: {
  env: NodeJS.ProcessEnv;
  getOwnerId(c: Context): string;
}): Hono {
  const runtimeConfig = loadPlatformSpeechRuntimeConfig(options.env);
  const client = runtimeConfig ? createPlatformSpeechClient(runtimeConfig) : undefined;
  return createSpeechGatewayRoutes({ client, getOwnerId: options.getOwnerId });
}
