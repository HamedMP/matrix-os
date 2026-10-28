import { BOT_INPUT_MAX_ATTACHMENTS, BOT_INPUT_MAX_IMAGES, BOT_INPUT_TOTAL_MAX_BYTES, BOT_INPUT_IMAGE_TOTAL_MAX_BYTES,
  type CanonicalChatMessagePart } from "@matrix-os/contracts";
import { prepareBotInputs, type PreparedBotInputs } from "./admitted-input.js";
import { BotBrokerActionError } from "./broker-actions.js";
import type { PiRuntimeBinding } from "./runtime-registry.js";
import { ChatSteerDeliveryUnknownError } from "../chat/steering-delivery.js";

type SteerPayload = { text: string; imageRange?: { start: number; count: number } };
/** Additional uploads share the active run's existing broker authority and memory budget. */
export async function prepareSteerableBotInputs(input: Parameters<typeof prepareBotInputs>[0]) {
  const initial = await prepareBotInputs(input);
  const retained: PreparedBotInputs[] = [initial]; // <= eight nonempty attachment batches plus initial.
  let pending = false, disposed = false;
  const invalid = () => new BotBrokerActionError("invalid_arguments");
  const dispose = () => { disposed = true; for (const batch of retained) batch.dispose(); retained.splice(1); input.signal.removeEventListener("abort", dispose); };
  input.signal.addEventListener("abort", dispose, { once: true });
  if (input.signal.aborted) dispose();
  const assertLive = (binding: PiRuntimeBinding) => {
    if (disposed) throw new BotBrokerActionError("stale_generation");
    initial.assertAuthorized(binding);
  };
  return {
    ...initial,
    get imageCount() { return initial.imageCount; },
    get fileAliases() { return retained.flatMap(batch => batch.fileAliases); },
    async readImageChunk(binding: PiRuntimeBinding, request: Parameters<PreparedBotInputs["readImageChunk"]>[1]) {
      assertLive(binding);
      let start = 0;
      for (const batch of retained) {
        if (request.index < start + batch.imageCount) return batch.readImageChunk(binding, { ...request, index: request.index - start });
        start += batch.imageCount;
      }
      throw invalid();
    },
    async readArtifact(binding: PiRuntimeBinding, args: Parameters<PreparedBotInputs["readArtifact"]>[1]) {
      assertLive(binding);
      const batch = retained.find(item => item.fileAliases.includes(args.relPath));
      return (batch ?? initial).readArtifact(binding, args);
    },
    async steer(binding: PiRuntimeBinding, parts: readonly CanonicalChatMessagePart[], text: string,
      deliver: (payload: SteerPayload) => Promise<boolean>): Promise<boolean> {
      assertLive(binding);
      if (pending) throw invalid();
      if (!parts.some(part => part.type === "attachment_reference")) return deliver({ text: text.slice(0, 8192) });
      if (input.historyFileRead === false && parts.some(part => part.type === "attachment_reference" && part.kind === "file")) throw invalid();
      pending = true;
      let staged: PreparedBotInputs | undefined;
      let dispatched = false;
      const release = () => {
        if (!staged) return;
        const index = retained.indexOf(staged); if (index >= 1) retained.splice(index, 1);
        staged.dispose();
      };
      try {
        staged = await prepareBotInputs({ ...input, parts, history: undefined });
        assertLive(binding);
        const usage = [...retained, staged].map(batch => batch.usage);
        if (usage.reduce((n, item) => n + item.count, 0) > BOT_INPUT_MAX_ATTACHMENTS
          || usage.reduce((n, item) => n + item.images, 0) > BOT_INPUT_MAX_IMAGES
          || usage.reduce((n, item) => n + item.bytes, 0) > BOT_INPUT_TOTAL_MAX_BYTES
          || usage.reduce((n, item) => n + item.imageBytes, 0) > (input.imageTotalMaximum ?? BOT_INPUT_IMAGE_TOTAL_MAX_BYTES)) throw invalid();
        const prompt = staged.prompt(text);
        if (prompt.length > 8192) throw invalid(); // Never truncate an alias or user instruction.
        const start = retained.reduce((n, batch) => n + batch.imageCount, 0);
        staged.bind(binding);
        retained.push(staged);
        await initial.revalidate(); assertLive(binding);
        dispatched = true;
        const accepted = await deliver({ text: prompt, ...(staged.imageCount ? { imageRange: { start, count: staged.imageCount } } : {}) });
        if (!accepted) release();
        return accepted;
      } catch (error: unknown) {
        // Unknown delivery can still be hydrating: keep its bounded bytes until Stop/terminal cleanup.
        if (!dispatched || !(error instanceof ChatSteerDeliveryUnknownError)) release();
        throw error;
      } finally { pending = false; }
    },
    dispose,
  };
}
export type SteerableBotInputs = Awaited<ReturnType<typeof prepareSteerableBotInputs>>;
