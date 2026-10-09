import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { AppAiInputSchema, AppAiResultSchema, AppAiRouteSelectionSchema, AppIdentitySchema, BotProviderConnectionSchema, ChatGptPlanWireSchema, CHATGPT_PLAN_RESPONSE_BYTE_LIMIT, type AiProviderSnapshotV3, type AppAiResult, type AppAiRouteSelection } from "@matrix-os/contracts";
import type { ChatGptPlanAuthority } from "../bots/chatgpt-plan.js";
import type { PiRuntimeBinding } from "../bots/runtime-registry.js";
import { assertChatGptPlanCompleted } from "../bots/chatgpt-plan-wire.js";
import { CHATGPT_PLAN_SOURCE, isCanonicalChatGptPlanAppRoute } from "./chatgpt-plan-projection.js";

const Message = z.object({ type: z.literal("message"), role: z.literal("assistant"), status: z.literal("completed"), content: z.array(z.object({ type: z.literal("output_text"), text: z.string().max(64000) })).max(128) });
const Output = z.array(z.union([Message, z.object({ type: z.literal("reasoning") })])).min(1).max(128);
function textFromSse(body: string, modelId: string): string {
  if (Buffer.byteLength(body) > CHATGPT_PLAN_RESPONSE_BYTE_LIMIT) throw new Error("Response too large");
  assertChatGptPlanCompleted(body, modelId);
  let text: string | undefined;
  for (const frame of body.replace(/\r\n/g, "\n").split("\n\n")) {
    const lines = frame.split("\n");
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") continue;
    const event = JSON.parse(data);
    const named = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
    if (named && named !== event.type || event.item && !["message", "reasoning"].includes(event.item.type)) throw new Error("Invalid response");
    if (event.type === "response.completed") text = Output.parse(event.response.output).flatMap(item => item.type === "message" ? item.content.map(part => part.text) : []).join("");
  }
  if (!text?.trim()) throw new Error("Missing text");
  return text;
}
/** No SDK agent, tools, workspace or credential copy: the exact owner device completes text. */
export async function generateChatGptPlanAppText(options: {
  ownerId: string; app: string; route: AppAiRouteSelection; canonical: AiProviderSnapshotV3; authority: ChatGptPlanAuthority;
  prompt: string; signal: AbortSignal; revalidate: () => Promise<boolean>;
}): Promise<AppAiResult> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), 30000);
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Cancelled")); signal.addEventListener("abort", abort, { once: true }); });
    try { return await Promise.race([operation(), cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }
  try {
    const app = AppIdentitySchema.parse(options.app);
    const route = AppAiRouteSelectionSchema.parse(options.route);
    const { prompt } = AppAiInputSchema.parse({ prompt: options.prompt });
    if (!options.ownerId || !isCanonicalChatGptPlanAppRoute(options.canonical, route)) throw new Error("Unavailable route");
    const observed = BotProviderConnectionSchema.parse(await wait(() => options.authority.observe(options.ownerId)));
    const source = options.canonical.accessSources.find(entry => entry.id === CHATGPT_PLAN_SOURCE)!;
    if (observed.id !== CHATGPT_PLAN_SOURCE || observed.accountId !== route.accountId || !observed.authorization.enabled || observed.availability !== "available" || !observed.models.some(model => model.id === route.modelId) || source.policyVersion !== `chatgpt-plan-${observed.authorization.revision}`) throw new Error("Unavailable account");
    const resolved = await wait(() => options.authority.resolve({ instanceId: CHATGPT_PLAN_SOURCE, model: route.modelId, options: [{ id: "accountId", value: route.accountId! }, { id: "grantRevision", value: String(observed.authorization.revision) }] }, options.ownerId, "interactive"));
    if (resolved.accessSourceId !== CHATGPT_PLAN_SOURCE || resolved.route.api !== "openai-responses" || resolved.route.modelId !== route.modelId || resolved.subscription?.accountId !== route.accountId || resolved.subscription.grantRevision !== observed.authorization.revision) throw new Error("Unavailable binding");
    // These references identify this direct completion only; no scope-runtime or broker tools are registered.
    const run = randomUUID().replace(/-/g, "");
    const binding: PiRuntimeBinding = { kind: "managed_chat", runtimeHandle: `runtime_${randomBytes(16).toString("hex")}`, executionGeneration: "1", ownerId: options.ownerId, chatId: `app-${app.replace(/\//g, "-").slice(0, 100)}`, runId: `run_${run}`, rootFingerprint: "0".repeat(64), workspace: { kind: "chat_workspace" }, capabilities: [], requestClass: "interactive", ...resolved };
    const authorized = async () => await wait(options.revalidate) && await wait(() => options.authority.revalidate(binding, signal));
    if (!await authorized()) throw new Error("Revoked");
    const body = JSON.stringify(ChatGptPlanWireSchema.parse({ model: route.modelId, stream: true, store: false, instructions: "Answer using only the supplied text. You have no tools or access to files.", input: [{ role: "user", content: prompt }] }));
    const response = await wait(() => options.authority.infer(binding, body, signal));
    if (response.status !== 200 || response.headers["content-type"] !== "text/event-stream") throw new Error("Unavailable response");
    const text = textFromSse(response.body, route.modelId);
    if (!await authorized()) throw new Error("Revoked");
    signal.throwIfAborted();
    return AppAiResultSchema.parse({ text });
  } catch (error) {
    console.warn("[app-ai] connected plan unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new Error("App AI is unavailable");
  } finally { clearTimeout(timer); }
}
