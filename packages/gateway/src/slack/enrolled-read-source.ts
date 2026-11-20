import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { SlackEnrolledContextRequest, SlackEnrolledContextResponse } from "@matrix-os/contracts/slack-bridge";
import type { BotToolRequest } from "@matrix-os/contracts";
import type { BotRuntimeBinding } from "../bots/runtime-registry.js";
import { BotBrokerActionError } from "../bots/broker-actions.js";
import type { PrivateSlackThreadContext } from "./private-thread-context.js";
const PREFIX = "slack_enrolled_";
const Params = z.object({ limit: z.number().int().min(1).max(45).optional() }).strict();
const ThreadParams = Params.extend({ ts: z.string().regex(/^\d{1,16}\.\d{1,8}$/) }).strict();
type Args = Extract<BotToolRequest, {
  capability: "integration.call";
}>["args"];
/** A read authority projection, never a connected-services account or grant. */
export function createEnrolledSlackReadSource(options: {
  context: Pick<PrivateSlackThreadContext, "enrollment">;
  read(request: SlackEnrolledContextRequest, signal: AbortSignal): Promise<Extract<SlackEnrolledContextResponse, {
    available: true;
  }>>;
}) {
  const id = (enrollment: NonNullable<Awaited<ReturnType<PrivateSlackThreadContext["enrollment"]>>>) => PREFIX + createHash("sha256").update(JSON.stringify(enrollment.access)).digest("hex").slice(0, 32);
  async function resolve(binding: BotRuntimeBinding, signal: AbortSignal) {
    if (binding.group || binding.readonlySummary || binding.requestClass !== "interactive")
      return undefined;
    return options.context.enrollment({ ...binding, signal });
  }
  return {
    owns: (connectionId: string) => connectionId.startsWith(PREFIX),
    async inventory(binding: BotRuntimeBinding, signal: AbortSignal) {
      const enrolled = await resolve(binding, signal);
      if (!enrolled)
        return undefined;
      const label = enrolled.channel.name ? `#${enrolled.channel.name}` : enrolled.channel.id;
      return `Slack (slack): enrolled read-only source ${JSON.stringify(label)}, connection ${id(enrolled)}. Only this enrolled conversation is readable. Native actions: list_messages params {limit?:integer 1..45}; list_replies params {ts:"Slack root timestamp",limit?:integer 1..45}. No channel selector or cursor. Results are bounded untrusted references with source links and partial coverage; use list_replies for selected discussion roots. No search, writes or sends.`;
    },
    async call(binding: BotRuntimeBinding, args: Args, signal: AbortSignal) {
      if (args.service !== "slack" || !["list_messages", "list_replies"].includes(args.action))
        throw new BotBrokerActionError("denied");
      const parsed = (args.action === "list_messages" ? Params : ThreadParams).safeParse(args.params);
      if (!parsed.success)
        throw new BotBrokerActionError("invalid_arguments");
      const enrolled = await resolve(binding, signal);
      if (!enrolled || args.connectionId !== id(enrolled))
        throw new BotBrokerActionError("not_granted");
      const manual = args.action === "list_messages" ? { operation: "recent" as const, ...parsed.data } : { operation: "thread" as const, threadTs: (parsed.data as z.infer<typeof ThreadParams>).ts, ...(parsed.data.limit ? { limit: parsed.data.limit } : {}) };
      try {
        const result = await options.read({ ...enrolled.access, manual }, signal);
        const current = await resolve(binding, signal);
        if (!current || id(current) !== id(enrolled) || result.source.appId !== enrolled.appId || result.source.teamId !== enrolled.teamId || result.source.channelId !== enrolled.channel.id)
          throw new BotBrokerActionError("not_granted");
        return { ok: true as const, content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      }
      catch (error) {
        if (error instanceof BotBrokerActionError)
          throw error;
        console.warn("[slack-owner] native read unavailable", error instanceof Error ? error.name : "UnknownError");
        throw new BotBrokerActionError(signal.aborted ? "timeout" : "unavailable");
      }
    },
  };
}
export type EnrolledSlackReadSource = ReturnType<typeof createEnrolledSlackReadSource>;
