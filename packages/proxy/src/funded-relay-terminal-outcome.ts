import { randomUUID } from "node:crypto";
import {
  FundedAiTerminalOutcomeRequestSchema,
  type FundedAiIdentity,
  type FundedAiStartResponse,
} from "@matrix-os/contracts";
import { observeRelayLocalResponse } from "./funded-relay-local-response.js";
import type { SettlementRetryQueue } from "./funded-relay-settlement-queue.js";
import { waitForRelayWork } from "./funded-relay-lifecycle.js";

/** Local termination evidence never claims remote provider cancellation or cost. */
export function createRelayTerminalRecorder(options: {
  identity: FundedAiIdentity & { tokenId: string };
  reservationId: string;
  requestId: string;
  now: () => Date;
  queue: SettlementRetryQueue;
  acknowledgementTimeoutMs?: number;
}) {
  let started: FundedAiStartResponse | undefined;
  let reporting: Promise<void> | undefined;
  let responseEnded: Promise<void> | undefined;
  const executionId = randomUUID();

  return {
    executionId,
    started: (response: FundedAiStartResponse) => { started = response; },
    response: (upstream: Response) => {
      const observed = observeRelayLocalResponse(upstream);
      responseEnded = observed.ended;
      return observed.response;
    },
    unknown: (terminalState: "completed" | "failed" | "cancelled"): Promise<void> => {
      if (!started) return Promise.resolve();
      if (reporting) return reporting;
      const binding = started;
      const publish = async () => {
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
        if (receipt.success) {
          const acknowledged = options.queue.enqueueTerminal(receipt.data);
          await options.queue.flush();
          // One prompt retry uses the same immutable receipt; the existing queue
          // retains any outage beyond the caller's bounded acknowledgement wait.
          await options.queue.flush();
          await acknowledged;
        }
        else console.warn("[proxy] Funded AI terminal evidence failed validation");
      };
      // The original body can outlive a failed transform or rejection parser.
      // Unconfirmed cancellation leaves this promise pending and fails closed.
      const publication = responseEnded ? responseEnded.then(publish) : publish();
      reporting = waitForRelayWork(publication, options.acknowledgementTimeoutMs ?? 1_000);
      return reporting;
    },
  };
}
