import { createNativeAppAiRequester } from "./native-app-ai";
import { createNativeAppAiRoutesRequester, createNativeAppCapabilityRequester, type NativeAppRequesterOptions } from "./native-app-capabilities";
import { createNativeAppFilesRequester, type NativeAppFilesRequester } from "./native-app-files";

/**
 * The gateway requesters that carry the owner's credentials for a native app:
 * capabilities, AI routes, AI calls and the app file bridge (files and open
 * requests). The main process spreads these into `NativeAppBridge` so the
 * file bridge cannot be left out when the capability bridge is wired.
 */
export function createNativeAppOwnerRequesters(options: NativeAppRequesterOptions): {
  capabilityRequest: ReturnType<typeof createNativeAppCapabilityRequester>;
  aiRoutesRequest: ReturnType<typeof createNativeAppAiRoutesRequester>;
  aiRequest: ReturnType<typeof createNativeAppAiRequester>;
  filesRequest: NativeAppFilesRequester;
} {
  return {
    capabilityRequest: createNativeAppCapabilityRequester(options),
    aiRoutesRequest: createNativeAppAiRoutesRequester(options),
    aiRequest: createNativeAppAiRequester(options),
    filesRequest: createNativeAppFilesRequester(options),
  };
}
