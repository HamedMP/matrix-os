import { createHash } from "node:crypto";
import { z } from "zod/v4";
import {
  buildPlatformSpeechRuntimeVerificationToken,
  buildPlatformVerificationToken,
} from "../platform-token.js";

const MachineSchema = z.object({
  machineId: z.string().min(1).max(160),
  clerkUserId: z.string().min(1).max(256),
  handle: z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/),
  runtimeSlot: z.string().min(1).max(32).regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
  runtimeTokenEpoch: z.number().int().min(1).max(2_147_483_647),
  publicIPv4: z.ipv4().nullable(),
}).strict();

export interface SpeechFleetActivationResult {
  activated: number;
  failed: number;
  results: Array<{
    machineId: string;
    handle: string;
    status: "activated" | "failed";
    error?: string;
  }>;
  detailsTruncated?: boolean;
}

async function configured(response: Response, expectedRevision: string): Promise<boolean> {
  if (!response.ok) return false;
  const responseText = await response.text();
  if (responseText.length > 1024) return false;
  try {
    const parsed = z.object({
      configured: z.boolean(),
      configurationRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    }).strict().parse(JSON.parse(responseText));
    return parsed.configured && parsed.configurationRevision === expectedRevision;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) {
      console.warn("[platform-speech] activation verification parse failed", error instanceof Error ? error.name : "UnknownError");
    }
    return false;
  }
}

export async function activatePlatformSpeechFleet(options: {
  machines: readonly z.input<typeof MachineSchema>[];
  platformOrigin: string;
  platformSecret: string;
  fetchImpl?: typeof fetch;
  fetchDispatcher?: import("undici").Dispatcher;
  wait?: (delayMs: number) => Promise<void>;
  verificationAttempts?: number;
  concurrency?: number;
}): Promise<SpeechFleetActivationResult> {
  const machines = z.array(MachineSchema).max(500).parse(options.machines);
  const origin = new URL(options.platformOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || options.platformSecret.length < 32) {
    throw new Error("Speech fleet activation is misconfigured");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const attempts = options.verificationAttempts ?? 12;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 30) {
    throw new Error("Speech activation verification policy is invalid");
  }
  const concurrency = options.concurrency ?? 16;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new Error("Speech activation concurrency is invalid");
  }

  const activate = async (machine: z.output<typeof MachineSchema>) => {
    const base = machine.publicIPv4 ? `https://${machine.publicIPv4}:443` : null;
    if (!base) {
      return { machineId: machine.machineId, handle: machine.handle, status: "failed" as const, error: "no IP" };
    }
    const authorization = `Bearer ${buildPlatformVerificationToken(machine.handle, options.platformSecret)}`;
    const runtimeToken = buildPlatformSpeechRuntimeVerificationToken({
      handle: machine.handle,
      machineId: machine.machineId,
      runtimeSlot: machine.runtimeSlot,
    }, options.platformSecret, machine.runtimeTokenEpoch);
    const expectedRevision = createHash("sha256")
      .update(`${machine.machineId}\0${machine.runtimeSlot}\0${origin.origin}\0${runtimeToken}`)
      .digest("hex");
    const requestOptions = () => ({
      headers: { authorization },
      signal: AbortSignal.timeout(10_000),
      redirect: "error" as const,
      ...(options.fetchDispatcher ? { dispatcher: options.fetchDispatcher } : {}),
    }) as RequestInit & { dispatcher?: import("undici").Dispatcher };
    try {
      const response = await fetchImpl(`${base}/api/internal/platform-speech/config`, {
        ...requestOptions(),
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({
          machineId: machine.machineId,
          runtimeSlot: machine.runtimeSlot,
          enabled: true,
          origin: origin.origin,
          runtimeToken,
        }),
      });
      if (!response.ok) {
        return { machineId: machine.machineId, handle: machine.handle, status: "failed" as const, error: `HTTP ${response.status}` };
      }
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        await wait(1_000);
        try {
          const status = await fetchImpl(`${base}/api/internal/platform-speech/config`, {
            ...requestOptions(),
            method: "GET",
          });
          if (await configured(status, expectedRevision)) {
            return { machineId: machine.machineId, handle: machine.handle, status: "activated" as const };
          }
        } catch (error: unknown) {
          if (attempt === attempts - 1) throw error;
        }
      }
      return { machineId: machine.machineId, handle: machine.handle, status: "failed" as const, error: "verification timeout" };
    } catch (error: unknown) {
      return { machineId: machine.machineId, handle: machine.handle, status: "failed" as const, error: "request failed" };
    }
  };
  const results: SpeechFleetActivationResult["results"] = new Array(machines.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, machines.length) }, async () => {
    while (nextIndex < machines.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await activate(machines[index]!);
    }
  }));
  const activated = results.filter((result) => result.status === "activated").length;
  return { activated, failed: results.length - activated, results };
}

export async function activatePlatformSpeechFleetPages(options: {
  pages: AsyncIterable<readonly z.input<typeof MachineSchema>[]>;
  platformOrigin: string;
  platformSecret: string;
  fetchImpl?: typeof fetch;
  fetchDispatcher?: import("undici").Dispatcher;
  wait?: (delayMs: number) => Promise<void>;
  verificationAttempts?: number;
  concurrency?: number;
  detailLimit?: number;
}): Promise<SpeechFleetActivationResult> {
  const detailLimit = options.detailLimit ?? 500;
  if (!Number.isSafeInteger(detailLimit) || detailLimit < 0 || detailLimit > 500) {
    throw new Error("Speech activation detail limit is invalid");
  }
  const aggregate: SpeechFleetActivationResult = { activated: 0, failed: 0, results: [] };
  for await (const machines of options.pages) {
    const batch = await activatePlatformSpeechFleet({ ...options, machines });
    aggregate.activated += batch.activated;
    aggregate.failed += batch.failed;
    const remaining = detailLimit - aggregate.results.length;
    if (remaining > 0) aggregate.results.push(...batch.results.slice(0, remaining));
    if (batch.results.length > remaining) aggregate.detailsTruncated = true;
  }
  return aggregate;
}
