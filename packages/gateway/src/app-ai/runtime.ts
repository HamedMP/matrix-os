import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { generateAppText } from "@matrix-os/kernel";
import { AppAiRequestSchema } from "@matrix-os/contracts";
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

/** Owner-controlled allowlist; app manifests cannot grant themselves model access. */
export function createRuntimeAppAiRoutes(options: {
  homePath: string;
  ownerIds: readonly string[];
  fundedCredentialProvider?: MatrixFundedCredentialProvider;
}) {
  return createAppAiRoutes({
    async authorize(context, app) {
      const principal = requireRequestPrincipal(context);
      if (!options.ownerIds.includes(principal.userId)) return false;
      return (await readPolicy(options.homePath))?.apps.includes(app) ?? false;
    },
    async generate(request, signal) {
      // Re-read so revoking a grant while credentials are being resolved fails closed.
      const policy = await readPolicy(options.homePath);
      if (!policy?.apps.includes(request.app)) throw new Error("App AI access denied");
      const sources = await resolveKernelCredentialSources(options.homePath, process.env, options.fundedCredentialProvider);
      if (sources.selectedAccessSourceId === "matrix_included" && !MATRIX_INCLUDED_MODEL_IDS.some((model) => model === policy.model)) {
        throw new Error("Model is unavailable for selected access");
      }
      const launch = await buildKernelCredentialLaunch(options.homePath, process.env, sources.selectedAccessSourceId, options.fundedCredentialProvider);
      signal.throwIfAborted();
      if (!launch.env) throw new Error("App AI credentials unavailable");
      const current = await readPolicy(options.homePath);
      if (!current?.apps.includes(request.app) || current.model !== policy.model) throw new Error("App AI policy changed");
      return generateAppText({
        prompt: request.prompt, model: policy.model, env: launch.env,
        signal: launch.fundedRunTimeoutMs
          ? AbortSignal.any([signal, AbortSignal.timeout(launch.fundedRunTimeoutMs)]) : signal,
      });
    },
  });
}
