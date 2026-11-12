import { generateAppText } from "@matrix-os/kernel";
import type { MatrixFundedCredentialProvider } from "../funded-ai-credential-manager.js";
import { generateApiAppText } from "../app-ai/api-completion.js";
import { buildKernelCredentialLaunch, resolveKernelCredentialSources } from "../kernel-credentials.js";

/** Completion-only model path. Matrix included access cannot launch the SDK. */
export async function generateSideChatText(options: { homePath: string; fundedCredentialProvider?: MatrixFundedCredentialProvider },
  prompt: string, signal: AbortSignal): Promise<{ text: string }> {
  const sources = await resolveKernelCredentialSources(options.homePath, process.env, options.fundedCredentialProvider);
  if (sources.selectedAccessSourceId === "matrix_included") {
    return generateApiAppText({
      homePath: options.homePath,
      fundedCredentialProvider: options.fundedCredentialProvider,
      route: { harnessId: "claude_code", accountId: null, accessSourceId: "matrix_included", modelId: "claude-sonnet-5" },
      prompt, signal,
      revalidate: async () => (await resolveKernelCredentialSources(options.homePath, process.env,
        options.fundedCredentialProvider)).selectedAccessSourceId === "matrix_included",
    });
  }
  const launch = await buildKernelCredentialLaunch(options.homePath, process.env, sources.selectedAccessSourceId,
    options.fundedCredentialProvider, { requestClass: "interactive" });
  if (!launch.env) throw new Error("SideChatCredentialsUnavailable");
  return generateAppText({ prompt, model: "claude-sonnet-5", env: launch.env,
    signal: launch.fundedRunTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(launch.fundedRunTimeoutMs)]) : signal });
}
