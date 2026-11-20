import { BoardMessageIdSchema, type BoardActor } from "@matrix-os/contracts/message-board";
import type { MessageBoardKernelTools } from "@matrix-os/kernel";
import { DEFAULT_AGENT_BOARD_CAN } from "./caller.js";
import { pollBoardEvents } from "./events.js";
import type { MessageBoardRuntime } from "./runtime.js";
import type { BoardCaller } from "./service.js";

const KERNEL_ACTOR: BoardActor = { id: "agent:matrix", kind: "agent", name: "Matrix" };

/**
 * The kernel's board tools: the gateway fixes the actor and owner here, at
 * registration, so model input can never choose who a post comes from.
 */
export function createMessageBoardKernelTools(runtime: MessageBoardRuntime, ownerId: string): MessageBoardKernelTools {
  if (!runtime || !ownerId) throw new Error("message board kernel tools need a runtime and an owner");
  const caller = (profile?: string): BoardCaller => ({
    ownerId, can: DEFAULT_AGENT_BOARD_CAN, actor: profile ? { ...KERNEL_ACTOR, profile } : KERNEL_ACTOR,
  });
  const { service, tasks, hub } = runtime;
  return {
    async read(input) {
      if (input.target && BoardMessageIdSchema.safeParse(input.target).success) {
        return service.getThread(caller(), input.board, input.target);
      }
      return service.listThreads(caller(), input.board, {
        channel: input.target ?? "*", label: input.label, text: input.text, limit: input.limit ?? 20,
      });
    },
    post: (input) => service.post(caller(input.profile), input.board, { channel: input.channel, text: input.text, labels: input.labels }),
    async reply(input) {
      const thread = await service.getThread(caller(), input.board, input.id);
      return service.post(caller(input.profile), input.board, { channel: thread.root.channel, text: input.text, re: input.id });
    },
    async label(input) {
      await service.label(caller(), input.board, input.id, {
        ...(input.set ? { set: input.set } : {}), ...(input.unset ? { unset: input.unset } : {}),
        ...(input.if ? { if: input.if } : {}), ...(input.ifUnset ? { ifUnset: input.ifUnset } : {}),
      });
      return { ok: true };
    },
    wait: (input) => pollBoardEvents({ service, hub }, ownerId, {
      board: input.board, after: input.after, waitSeconds: input.timeoutSeconds ?? 25, limit: 50, channel: input.channel, thread: input.thread,
    }),
    taskCreate: (input) => tasks.create(caller(input.profile), input.board, {
      channel: input.channel, text: input.text, needs: input.needs, forProfile: input.forProfile, labels: input.labels,
    }),
    taskClaim: (input) => tasks.claim(caller(input.profile), input.board, input.id
      ? { id: input.id, leaseSeconds: input.leaseSeconds }
      : { ready: input.ready ?? "*", label: input.label, from: input.from, leaseSeconds: input.leaseSeconds }),
    taskRenew: (input) => tasks.renew(caller(), input.board, input.id, { epoch: input.epoch, token: input.token, leaseSeconds: input.leaseSeconds }),
    async taskSettle(input) {
      const proof = { epoch: input.epoch, token: input.token };
      if (input.outcome === "complete") await tasks.complete(caller(), input.board, input.id, { ...proof, result: input.text });
      else if (input.outcome === "release") await tasks.release(caller(), input.board, input.id, proof);
      else if (input.outcome === "fail") await tasks.fail(caller(), input.board, input.id, { ...proof, reason: input.text?.trim() || "Failed" });
      else await tasks.block(caller(), input.board, input.id, { ...proof, reason: input.text?.trim() || "Needs a person", kind: input.kind });
      return { ok: true, outcome: input.outcome };
    },
  };
}
