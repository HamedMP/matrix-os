import {
  MatrixAnthropicConnectionSchema, MatrixAnthropicConnectSchema,
  MatrixAnthropicDisconnectSchema, MatrixAnthropicRefreshSchema,
  type MatrixAnthropicConnection, type MatrixAnthropicConnect,
  type MatrixAnthropicDisconnect, type MatrixAnthropicRefresh,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { ProviderWorkflowClientError, type ProviderWorkflowRequest } from "./provider-workflow-client.js";

export interface MatrixAnthropicConnectionClient {
  status(signal: AbortSignal): Promise<MatrixAnthropicConnection>;
  connect(input: MatrixAnthropicConnect, signal: AbortSignal): Promise<MatrixAnthropicConnection>;
  refresh(input: MatrixAnthropicRefresh, signal: AbortSignal): Promise<MatrixAnthropicConnection>;
  disconnect(input: MatrixAnthropicDisconnect, signal: AbortSignal): Promise<MatrixAnthropicConnection>;
}

/** The host supplies bounded current-owner/Computer transport. Never negotiates a native login fallback. */
export function createMatrixAnthropicConnectionClient(
  request: (input: ProviderWorkflowRequest) => Promise<unknown>,
): MatrixAnthropicConnectionClient {
  const root = "/api/ai/matrix-connections/anthropic";
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ProviderWorkflowClientError();
    return result.data;
  }
  async function send(input: ProviderWorkflowRequest): Promise<MatrixAnthropicConnection> {
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    let value: unknown;
    try { value = await request(input); }
    catch (error: unknown) {
      console.warn("[matrix-connection] Request unavailable:", error instanceof Error ? error.name : typeof error);
      if (error instanceof ProviderWorkflowClientError) throw error;
      throw new ProviderWorkflowClientError();
    }
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    return parse(MatrixAnthropicConnectionSchema, value);
  }
  return {
    status: signal => send({ path: root, method: "GET", signal }),
    connect: async (input, signal) => send({ path: `${root}/connect`, method: "POST", body: parse(MatrixAnthropicConnectSchema, input), signal }),
    refresh: async (input, signal) => send({ path: `${root}/refresh`, method: "POST", body: parse(MatrixAnthropicRefreshSchema, input), signal }),
    disconnect: async (input, signal) => send({ path: `${root}/disconnect`, method: "POST", body: parse(MatrixAnthropicDisconnectSchema, input), signal }),
  };
}
