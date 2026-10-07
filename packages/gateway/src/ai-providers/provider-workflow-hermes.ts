import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { buildAgentRuntimeEnvironment } from "../agent-launcher.js";
import { ProviderWorkflowError } from "./provider-workflows.js";

// The same native helpers used by Hermes's official import confirmation flow.
// Credential bytes stay entirely inside the owner-native Python process. Matrix
// receives only exit success. This action is never invoked by a status refresh.
export const HERMES_CODEX_REUSE_SCRIPT = `
import sys, os
sys.stdout = open(os.devnull, "w")
sys.stderr = open(os.devnull, "w")
os.dup2(sys.stdout.fileno(), 1)
os.dup2(sys.stderr.fileno(), 2)
try:
    from hermes_cli.auth import _import_codex_cli_tokens, _save_codex_tokens, _update_config_for_provider
    from hermes_cli.auth_codex import _codex_base_url
    tokens = _import_codex_cli_tokens()
    if not tokens:
        sys.exit(2)
    _save_codex_tokens(tokens)
    _update_config_for_provider("openai-codex", _codex_base_url())
except Exception:
    sys.exit(1)
`;

export function createHermesCodexReuse(options: { homePath: string }) {
  const homePath = resolve(options.homePath);
  const installation = join(homePath, ".hermes/hermes-agent");
  return async () => {
    try {
      await promisify(execFile)(join(installation, "venv/bin/python"), ["-c", HERMES_CODEX_REUSE_SCRIPT], {
        cwd: installation, env: { ...buildAgentRuntimeEnvironment(homePath), HERMES_HOME: join(homePath, ".hermes"), CODEX_HOME: join(homePath, ".codex") },
        timeout: 10000, maxBuffer: 4096, windowsHide: true,
      });
    } catch (error) {
      console.warn("[provider-workflow] Native account reuse unavailable:", error instanceof Error ? error.name : "UnknownError");
      throw new ProviderWorkflowError("unavailable");
    }
  };
}
