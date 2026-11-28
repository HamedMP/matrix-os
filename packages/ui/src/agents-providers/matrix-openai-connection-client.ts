import {
  MatrixOpenAiConnectionSchema, MatrixOpenAiConnectSchema,
  MatrixOpenAiDisconnectSchema, MatrixOpenAiRefreshSchema,
  type MatrixOpenAiConnection, type MatrixOpenAiConnect,
  type MatrixOpenAiDisconnect, type MatrixOpenAiRefresh,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { ProviderWorkflowClientError, type ProviderWorkflowRequest } from "./provider-workflow-client.js";

export interface MatrixOpenAiConnectionClient {
  status(signal: AbortSignal): Promise<MatrixOpenAiConnection>;
  connect(input: MatrixOpenAiConnect, signal: AbortSignal): Promise<MatrixOpenAiConnection>;
  refresh(input: MatrixOpenAiRefresh, signal: AbortSignal): Promise<MatrixOpenAiConnection>;
  disconnect(input: MatrixOpenAiDisconnect, signal: AbortSignal): Promise<MatrixOpenAiConnection>;
}

/** The host supplies bounded current-owner/Computer transport. Never negotiates a native login fallback. */
export function createMatrixOpenAiConnectionClient(
  request: (input: ProviderWorkflowRequest) => Promise<unknown>,
): MatrixOpenAiConnectionClient {
  const root = "/api/ai/matrix-connections/openai";
  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) throw new ProviderWorkflowClientError();
    return result.data;
  }
  async function send(input: ProviderWorkflowRequest): Promise<MatrixOpenAiConnection> {
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    let value: unknown;
    try { value = await request(input); }
    catch (error: unknown) {
      console.warn("[matrix-connection] Request unavailable:", error instanceof Error ? error.name : typeof error);
      if (error instanceof ProviderWorkflowClientError) throw error;
      throw new ProviderWorkflowClientError();
    }
    if (input.signal.aborted) throw new ProviderWorkflowClientError();
    return parse(MatrixOpenAiConnectionSchema, value);
  }
  return {
    status: signal => send({ path: root, method: "GET", signal }),
    connect: async (input, signal) => send({ path: `${root}/connect`, method: "POST", body: parse(MatrixOpenAiConnectSchema, input), signal }),
    refresh: async (input, signal) => send({ path: `${root}/refresh`, method: "POST", body: parse(MatrixOpenAiRefreshSchema, input), signal }),
    disconnect: async (input, signal) => send({ path: `${root}/disconnect`, method: "POST", body: parse(MatrixOpenAiDisconnectSchema, input), signal }),
  };
}
