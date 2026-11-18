import type { Kysely } from "kysely";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer, SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import type { ModelInput, ModelResult } from "./contracts.js";
import type { HostedBotsDatabase } from "./database.js";
import { createHostedBotsCredentials, hostedBotsCredentialPath, isHostedBotsCredentialDirectoryUsable } from "./model-credentials.js";
import { createOpenMausPreviewModel } from "./model.js";
import { admitsHostedBotsPrivatePreview } from "./preview-admission.js";
import { createHostedBotsRepository, type HostedBotsRepository } from "./repository.js";
import { createHostedBotsRoutes } from "./routes.js";

const TICK_MS = 2_000;
const RUN_TIMEOUT_MS = 60_000;

export function startHostedBotsWorker(options: {
  repository: HostedBotsRepository;
  ownerId: string;
  model(input: ModelInput, signal: AbortSignal): Promise<ModelResult>;
}) {
  const stop = new AbortController();
  let current: Promise<void> | undefined;

  async function tick() {
    while (!stop.signal.aborted) {
      const run = await options.repository.claim(options.ownerId);
      if (!run) return;
      let result: ModelResult | undefined;
      try {
        const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(RUN_TIMEOUT_MS)]);
        signal.throwIfAborted();
        result = await options.model(run, signal);
      } catch (error) {
        console.warn("[hosted-bots] Model run failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
      }
      await options.repository.finish(run, result);
    }
  }

  function wake() {
    if (current || stop.signal.aborted) return;
    current = tick().catch((error: unknown) => {
      console.warn("[hosted-bots] Worker failed", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }).finally(() => { current = undefined; });
  }
  const timer = setInterval(wake, TICK_MS);
  timer.unref();
  wake();
  return {
    wake,
    async close() {
      clearInterval(timer);
      stop.abort();
      await current;
    },
  };
}

export async function initializeHostedBotsRuntime(
  db: Kysely<HostedBotsDatabase> | null, env: NodeJS.ProcessEnv, ownerHome: string,
) {
  const admitted = admitsHostedBotsPrivatePreview(env);
  const credentialPath = admitted ? hostedBotsCredentialPath(env.STATE_DIRECTORY, ownerHome) : null;
  let repository: HostedBotsRepository | null = null;
  let credentials: ReturnType<typeof createHostedBotsCredentials> | null = null;
  if (admitted && db && credentialPath) {
    try {
      if (await isHostedBotsCredentialDirectoryUsable(credentialPath, ownerHome)) {
        repository = await createHostedBotsRepository(db);
        credentials = createHostedBotsCredentials(credentialPath);
      }
    } catch (error) {
      console.warn("[hosted-bots] Store unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" });
    }
  }
  const configuredOwner = env.MATRIX_USER_ID?.trim();
  const primaryOwner = configuredOwner && SAFE_PRINCIPAL_USER_ID.test(configuredOwner) ? configuredOwner : null;
  const clerkOwner = env.MATRIX_CLERK_USER_ID?.trim();
  const worker = repository && credentials && primaryOwner ? startHostedBotsWorker({
    repository,
    ownerId: primaryOwner,
    model: createOpenMausPreviewModel({ readKey: credentials.readKey }),
  }) : null;
  const routes = createHostedBotsRoutes({
    admitted,
    repository,
    resolveOwner: (c) => {
      if (!hasVerifiedRuntimeBearer(c)) return null;
      const principal = getOptionalRequestPrincipal(c);
      if (!principal || !primaryOwner || (principal.source !== "jwt" && principal.source !== "platform-verified")) return null;
      return principal.userId === primaryOwner || principal.userId === clerkOwner ? primaryOwner : null;
    },
    model: credentials ?? {
      connected: async () => false,
      async connect() { throw new Error("Bot credential store unavailable"); },
    },
    wake: () => worker?.wake(),
  });
  return { routes, close: () => worker?.close() };
}
