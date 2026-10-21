import { randomUUID } from "node:crypto";
import {
  FundedAiTerminalOutcomeRequestSchema,
  type FundedAiIdentity,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import { observeRelayLocalResponse } from "./funded-relay-local-response.js";
import type { SettlementRetryQueue } from "./funded-relay-settlement-queue.js";

/** Local termination evidence never claims remote provider cancellation or cost. */
export function createRelayTerminalRecorder(options: {
  identity: FundedAiIdentity & { tokenId: string };
  reservationId: string;
  requestId: string;
  now: () => Date;
  queue: SettlementRetryQueue;
}) {
  let started: FundedAiStartResponse | undefined;
  let emitted = false;
  let responseEnded: Promise<void> | undefined;
  const executionId = randomUUID();

  return {
    started: (response: FundedAiStartResponse) => { started = response; },
    response: (upstream: Response) => {
      const observed = observeRelayLocalResponse(upstream);
      responseEnded = observed.ended;
      return observed.response;
    },
    unknown: (terminalState: "completed" | "failed" | "cancelled") => {
      if (!started || emitted) return;
      emitted = true;
      const binding = started;
      const publish = () => {
        const receipt = FundedAiTerminalOutcomeRequestSchema.safeParse({
          contractVersion: 1,
          reservationId: options.reservationId,
          requestId: options.requestId,
          tokenId: options.identity.tokenId,
          ownerId: options.identity.ownerId,
          machineId: options.identity.machineId,
          runtimeSlot: options.identity.runtimeSlot,
          startedAt: binding.startedAt,
          expiresAt: binding.expiresAt,
          executionId,
          terminalState,
          terminalAt: options.now().toISOString(),
          outcome: "usage_unknown",
        });
        if (receipt.success) options.queue.enqueueTerminal(receipt.data);
        else console.warn("[proxy] Funded AI terminal evidence failed validation");
      };
      // The original body can outlive a failed transform or rejection parser.
      // Unconfirmed cancellation leaves this promise pending and fails closed.
      if (responseEnded) void responseEnded.then(publish);
      else publish();
    },
  };
}
