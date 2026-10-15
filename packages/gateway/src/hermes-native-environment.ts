import { join } from "node:path";
import { buildAgentRuntimeEnvironment } from "./agent-launcher.js";

/** Native Hermes owns its profile/auth files; Gateway credentials must never enter its process. */
export function buildHermesNativeEnvironment(homePath: string, nativeRoot: string): Record<string, string> {
  return {
    ...buildAgentRuntimeEnvironment(homePath),
    HERMES_HOME: join(homePath, ".hermes"),
    HERMES_PYTHON_SRC_ROOT: nativeRoot,
    PYTHONPATH: nativeRoot,
    PYTHONUNBUFFERED: "1",
    LANG: "C.UTF-8",
  };
}
