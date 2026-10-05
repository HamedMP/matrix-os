import { MEMORY_IMPORT_INVOKE } from "../../shared/memory-import-ipc";
import type { createMemoryImportService } from "./service";
interface Main {
  handle(
    channel: string,
    listener: (event: unknown, input: unknown) => Promise<unknown>,
  ): void;
}
export function registerMemoryImportIpc(
  ipc: Main,
  service: ReturnType<typeof createMemoryImportService>,
  isTrusted: (event: unknown) => boolean,
) {
  if (
    !service ||
    typeof service.inventory !== "function" ||
    typeof service.preview !== "function" ||
    typeof service.confirm !== "function" ||
    typeof service.file !== "function" ||
    typeof service.cancelAll !== "function" ||
    typeof isTrusted !== "function"
  )
    throw Error("Memory import unavailable");
  for (const [channel, contract] of Object.entries(MEMORY_IMPORT_INVOKE))
    ipc.handle(channel, async (event, input) => {
      if (!isTrusted(event)) throw Error("invalid request");
      const parsed = contract.request.safeParse(input ?? {});
      if (!parsed.success) throw Error("invalid request");
      const result =
        channel === "memory:import-inventory"
          ? await service.inventory(
              MEMORY_IMPORT_INVOKE["memory:import-inventory"].request.parse(
                parsed.data,
              ),
            )
          : channel === "memory:import-preview"
            ? await service.preview(
                MEMORY_IMPORT_INVOKE["memory:import-preview"].request.parse(
                  parsed.data,
                ),
              )
            : channel === "memory:import-confirm"
              ? await service.confirm(
                  MEMORY_IMPORT_INVOKE["memory:import-confirm"].request.parse(
                    parsed.data,
                  ),
                )
              : channel === "memory:import-file"
                ? await service.file()
                : service.cancelAll();
      const response = contract.response.safeParse(result);
      if (!response.success) throw Error("internal error");
      return response.data;
    });
}
