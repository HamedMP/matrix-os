import { NAVIGATION_CACHE_INVOKE } from "../../shared/navigation-cache-ipc";
import type { createNavigationCache } from "../persistence/navigation-cache";
interface Main {
  handle(channel: string, listener: (event: unknown, input: unknown) => Promise<unknown>): void;
}
type Service = ReturnType<typeof createNavigationCache>;
export function registerNavigationCacheIpc(ipc: Main, service: Service, isTrusted: (event: unknown) => boolean) {
  if (!service || (["context", "load", "save", "clear"] as const).some(method => typeof service[method] !== "function") || typeof isTrusted !== "function")
    throw new Error("navigation cache unavailable");
  for (const [channel, contract] of Object.entries(NAVIGATION_CACHE_INVOKE)) {
    ipc.handle(channel, async (event, input) => {
      if (!isTrusted(event))
        throw new Error("invalid request");
      const parsed = contract.request.safeParse(input);
      if (!parsed.success)
        throw new Error("invalid request");
      try {
        let result: unknown;
        if (channel === "navigation-cache:context") {
          result = service.context();
        }
        else if (channel === "navigation-cache:load") {
          result = await service.load(NAVIGATION_CACHE_INVOKE["navigation-cache:load"].request.parse(parsed.data));
        }
        else if (channel === "navigation-cache:save") {
          result = await service.save(NAVIGATION_CACHE_INVOKE["navigation-cache:save"].request.parse(parsed.data));
        }
        else {
          result = await service.clear(NAVIGATION_CACHE_INVOKE["navigation-cache:clear"].request.parse(parsed.data));
        }
        return contract.response.parse(result);
      }
      catch (error: unknown) {
        console.warn("[navigation-cache] IPC operation failed", error instanceof Error ? error.name : "UnknownError");
        throw new Error("internal error");
      }
    });
  }
}
