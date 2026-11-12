import { useCallback } from "react";
import type { ProjectChatSlashScope } from "@matrix-os/ui";
import { PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT } from "@matrix-os/ui/project-agent-context";
import { AppError } from "../../../../shared/app-error";
import { useConnection } from "../../stores/connection";
import { captureRuntimeGeneration, isCurrentRuntimeGeneration } from "../../stores/runtime-generation";

export function useDesktopProjectAgentContextReader() {
  const api = useConnection(state => state.api);
  const runtimeSlot = useConnection(state => state.runtimeSlot);
  const authGeneration = useConnection(state => state.authGeneration);
  const scope = JSON.stringify([api?.baseUrl, runtimeSlot, authGeneration]);
  const read = useCallback(async (path: string, signal: AbortSignal) => {
    if (!api) return null;
    const generation = captureRuntimeGeneration();
    const current = () => {
      const state = useConnection.getState();
      return !signal.aborted && isCurrentRuntimeGeneration(generation) && state.api === api
        && state.runtimeSlot === runtimeSlot && state.authGeneration === authGeneration;
    };
    if (!current()) return null;
    try {
      const body = await api.forRuntime(runtimeSlot).get<unknown>(path, {
        signal, cache: "no-store", maxBytes: PROJECT_AGENT_CONTEXT_RESPONSE_LIMIT, omitErrorBody: true,
      });
      return current() ? body : null;
    } catch (error: unknown) {
      if (!current() || (error instanceof AppError && [403, 404].includes(error.httpStatus ?? 0))) return null;
      throw error;
    }
  }, [api, runtimeSlot, authGeneration]);
  return { scope, read: api ? read : null };
}

export function useDesktopProjectSlashScope(projectId: string | undefined, canRead: boolean): ProjectChatSlashScope | undefined {
  const { scope, read } = useDesktopProjectAgentContextReader();
  return projectId ? { projectId, scope, read: canRead ? read : null } : undefined;
}
