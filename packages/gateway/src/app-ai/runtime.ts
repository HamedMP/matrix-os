import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { generateAppText } from "@matrix-os/kernel";
import { APP_AI_TIMEOUT_MS, AppAiRequestSchema, AppAiResultSchema, type AppAiRequest } from "@matrix-os/contracts";
import { buildKernelCredentialLaunch, resolveKernelCredentialSources } from "../kernel-credentials.js";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { requireRequestPrincipal } from "../request-principal.js";
import { MATRIX_INCLUDED_MODEL_IDS } from "../ai-providers/model-catalog.js";
import { KernelModelSchema } from "../kernel-settings.js";
import { createAppAiRoutes } from "./routes.js";

const PolicySchema = z.strictObject({
  apps: z.array(AppAiRequestSchema.shape.app).max(100),
  model: KernelModelSchema,
});

async function readPolicy(homePath: string) {
  try {
    const bytes = await readFile(join(homePath, "system/app-ai.json"));
    if (bytes.length > 32_768) throw new Error("Invalid app AI policy");
    return PolicySchema.parse(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

interface RuntimeAppAiOptions {
  homePath: string;
  ownerIds: readonly string[];
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
}

/** One owner-policy and admission boundary for interactive and scheduled generation. */
export function createRuntimeAppAiService(options: RuntimeAppAiOptions) {
  let inFlight = 0;
  let requests = 0;
  let windowStart = 0;
  async function authorize(ownerId: string, app: string) {
    if (!options.ownerIds.includes(ownerId)) return false;
    return (await readPolicy(options.homePath))?.apps.includes(app) ?? false;
  }
  return {
    authorize,
    async generate(ownerId: string, input: AppAiRequest, callerSignal: AbortSignal) {
      const request = AppAiRequestSchema.parse(input);
      if (!await authorize(ownerId, request.app)) throw new Error("App AI access denied");
      const now = Date.now();
      if (now - windowStart >= 60_000) { windowStart = now; requests = 0; }
      if (inFlight >= 2 || requests >= 10) throw new Error("App AI is busy");
      requests++; inFlight++;
      const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(APP_AI_TIMEOUT_MS)]);
      // The slot stays held until the actual driver settles, including on cancellation.
      try {
        signal.throwIfAborted();
        const policy = await readPolicy(options.homePath);
        if (!policy?.apps.includes(request.app)) throw new Error("App AI access denied");
        const sources = await resolveKernelCredentialSources(options.homePath, process.env, options.fundedCredentialProvider);
        if (sources.selectedAccessSourceId === "matrix_included" && !MATRIX_INCLUDED_MODEL_IDS.some((model) => model === policy.model)) {
          throw new Error("Model is unavailable for selected access");
        }
        const launch = await buildKernelCredentialLaunch(options.homePath, process.env, sources.selectedAccessSourceId, options.fundedCredentialProvider, { requestClass: "interactive" });
        signal.throwIfAborted();
        if (!launch.env) throw new Error("App AI credentials unavailable");
        const current = await readPolicy(options.homePath);
        if (!current?.apps.includes(request.app) || current.model !== policy.model) throw new Error("App AI policy changed");
        const result = await generateAppText({
          prompt: request.prompt, model: policy.model, env: launch.env,
          signal: launch.fundedRunTimeoutMs
            ? AbortSignal.any([signal, AbortSignal.timeout(launch.fundedRunTimeoutMs)]) : signal,
        });
        signal.throwIfAborted();
        const finalPolicy = await readPolicy(options.homePath);
        if (!options.ownerIds.includes(ownerId) || !finalPolicy?.apps.includes(request.app) || finalPolicy.model !== policy.model) throw new Error("App AI policy changed");
        return AppAiResultSchema.parse(result);
      } finally { inFlight--; }
    },
  };
}
export type RuntimeAppAiService = ReturnType<typeof createRuntimeAppAiService>;

/** Owner-controlled allowlist; app manifests cannot grant themselves model access. */
export function createRuntimeAppAiRoutes(options: RuntimeAppAiOptions & { service?: RuntimeAppAiService }) {
  const service = options.service ?? createRuntimeAppAiService(options);
  return createAppAiRoutes({
    authorize(context, app) { return service.authorize(requireRequestPrincipal(context).userId, app); },
    generate(request, signal, context) {
      return service.generate(requireRequestPrincipal(context).userId, request, signal);
    },
  });
}
