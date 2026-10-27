import { AppIdentitySchema, AppRepairDiagnosticSchema, submitAppRepairChat, type AppRepairDiagnostic } from "@matrix-os/contracts";
import { requestNativeAppJson, type NativeAppRequesterOptions } from "./native-app-capabilities";

/** Runs in main so a renderer cannot choose the app identity, gateway or owner credential. */
export function createNativeAppRepairRequester(options: NativeAppRequesterOptions) {
  return async (app: string, rawDiagnostic: AppRepairDiagnostic, signal?: AbortSignal): Promise<{ chatId: string }> => {
    const identity = app === "Matrix OS" ? app : AppIdentitySchema.parse(app);
    const diagnostic = AppRepairDiagnosticSchema.parse(rawDiagnostic);
    return submitAppRepairChat((path, init) => requestNativeAppJson(options, path,
      { method: init?.method ?? "GET", body: init?.body }, 1_000_000, signal, 12_000),
    { app: identity, surface: "Electron Desktop", ...diagnostic });
  };
}
