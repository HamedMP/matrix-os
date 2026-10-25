import type { Kysely } from "kysely";
import { createChatAnalyticsStore, createTransientChatClassifier } from "../chat-analytics/index.js";
import { CHAT_USAGE_CLASSIFIER_MODEL, createFundedChatUsageTransport } from "../chat-usage-classifier-transport.js";
import type { ChatUsageRuntime } from "../chat-usage-routes.js";
import type { FundedAiRuntimeConfig, MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";

/** Optional owner-DB service. Default off; this never enables an owner's policy. */
export async function startChatUsageAnalytics(options: {
  env?: NodeJS.ProcessEnv;
  db: Kysely<any> | null;
  ownerId: string | null;
  fundedConfig?: FundedAiRuntimeConfig;
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
}): Promise<ChatUsageRuntime | undefined> {
  const env = options.env ?? process.env;
  if (env.MATRIX_CHAT_ANALYTICS_ENABLED !== "true") return undefined;
  if (!options.db || !options.ownerId || !options.fundedCredentialProvider || !options.fundedConfig
    || options.fundedConfig.identity.ownerId !== options.ownerId) throw new Error("Chat usage unavailable");
  const store = createChatAnalyticsStore(options.db);
  await store.migrate();
  const classify = createFundedChatUsageTransport({ provider: options.fundedCredentialProvider,
    relayBaseUrl: options.fundedConfig.relayBaseUrl });
  const classifier = createTransientChatClassifier({ store, classify, enabled: true });
  let sweep: Promise<unknown> | undefined;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped || sweep) return;
    const operation = store.expire().catch((error: unknown) => {
      console.warn("[chat-usage] retention unavailable", error instanceof Error ? error.name : "UnknownError");
    }).finally(() => { if (sweep === operation) sweep = undefined; });
    sweep = operation;
  }, 5 * 60_000);
  timer.unref();
  return { store, modelId: CHAT_USAGE_CLASSIFIER_MODEL, classifier: { ...classifier, async close() {
    stopped = true;
    clearInterval(timer);
    const classifierResult = await classifier.close();
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      if (sweep) await Promise.race([sweep, new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); })]);
      return { drained: classifierResult.drained && !sweep };
    } finally { if (deadline) clearTimeout(deadline); }
  } } };
}
