import { APP_GENERATE_CHANNEL, createAppGenerateClient, APP_AI_CHANNEL, APP_AI_ROUTES_CHANNEL, createAppAiClient } from "@matrix-os/contracts";
// The only bridge between renderer and trusted core. Exposes exactly the
// typed contract — payloads are validated here AND in main (defense in depth,
// FR-081). The credential never crosses this boundary.
import { contextBridge, ipcRenderer } from "electron";
import { NATIVE_APP_OPEN_CHANNEL, createNativeAppOpenClient } from "../shared/native-app-open";
import { NATIVE_APP_OPEN_CHAT_CHANNEL, createNativeAppOpenChatClient } from "../shared/native-app-chat";
import { createOperatorBridge } from "../shared/operator-bridge";
import { TERMINAL_WINDOW_ARG } from "../shared/terminal-window";
import {
  NATIVE_APP_QUERY_CHANNEL,
  createNativeAppDatabase,
  type NativeAppQuery,
} from "../shared/native-app-bridge";
import {
  NATIVE_APP_ACTIVITY_BRIDGE_ARG,
  NATIVE_APP_GALLERY_BRIDGE_ARG,
  NATIVE_APP_INTEGRATIONS_BRIDGE_ARG,
  NATIVE_APP_BROWSER_BRIDGE_ARG,
  createNativeAppIntegrations,
  NATIVE_APP_GATEWAY_CHANNEL,
  createNativeAppGatewayFetch,
} from "../shared/native-app-gateway";

import { APP_CAPABILITY_CHANNEL, createNativeAppCapabilityClient, settleAppCapabilityClient } from "../shared/native-app-capabilities";
import { APP_FILES_CHANNEL, NATIVE_APP_OPEN_REQUEST_CHANNEL, createNativeAppFilesBridge, watchOpenRequestSignals } from "../shared/native-app-files";
import { NATIVE_APP_COLLABORATION_CHANNEL, NATIVE_COLLABORATION_ERROR_KEY, NativeAppCollaborationError, createNativeAppCollaboration } from "../shared/native-app-collaboration";
import { CollaborationSafeErrorCodeSchema } from "@matrix-os/contracts";
import { CollaborativeAppParticipantSchema } from "@matrix-os/contracts";

const NATIVE_APP_BRIDGE_ARG = "--matrix-app-bridge";

// The Terminal window loads this same preload (a sandboxed preload is one
// bundled entry) but is given only its allowlisted channels.
const api = createOperatorBridge(
  ipcRenderer,
  process.argv.includes(TERMINAL_WINDOW_ARG) ? "terminal" : "main",
);

export type OperatorBridge = typeof api;

if (process.argv.includes(NATIVE_APP_BRIDGE_ARG)) {
  const participantArgument = process.argv.find((value) => value.startsWith("--matrix-app-participant="));
  let ownerParticipant = null;
  if (participantArgument && participantArgument.length < 2_048) {
    try { ownerParticipant = CollaborativeAppParticipantSchema.parse(JSON.parse(decodeURIComponent(participantArgument.slice("--matrix-app-participant=".length)))); }
    catch (error: unknown) { console.warn("[native-app-preload] participant unavailable", error instanceof Error ? error.name : "UnknownError"); }
  }
  const database = createNativeAppDatabase((query: NativeAppQuery) =>
    ipcRenderer.invoke(NATIVE_APP_QUERY_CHANNEL, query));
  const collaboration = createNativeAppCollaboration(
    async (request) => {
      const result: unknown = await ipcRenderer.invoke(NATIVE_APP_COLLABORATION_CHANNEL, request);
      if (result && typeof result === "object" && NATIVE_COLLABORATION_ERROR_KEY in result) {
        const code = CollaborationSafeErrorCodeSchema.safeParse(result[NATIVE_COLLABORATION_ERROR_KEY]);
        throw new NativeAppCollaborationError(code.success ? code.data : "unavailable");
      }
      return result;
    }, ownerParticipant,
    (participant) => contextBridge.executeInMainWorld({
      func: (currentParticipant) => {
        const api = (window as unknown as { MatrixOS?: { collaboration?: { participant: unknown } } }).MatrixOS;
        if (api?.collaboration) api.collaboration.participant = currentParticipant;
      },
      args: [participant],
    }),
  );
  const capabilityClient = createNativeAppCapabilityClient((input) => ipcRenderer.invoke(APP_CAPABILITY_CHANNEL, input));
  const ownerIntegrations = process.argv.includes(NATIVE_APP_INTEGRATIONS_BRIDGE_ARG);
  const { integrations: settledIntegrations, ...settledCapabilities } = settleAppCapabilityClient(capabilityClient);
  contextBridge.exposeInMainWorld("__matrixNativeBridge", Object.freeze({
    db: database,
    collaboration,
    ...capabilityClient,
    // Results, not errors: the page world rethrows them with their safe status.
    capabilityResults: Object.freeze({ ...settledCapabilities, ...(ownerIntegrations ? {} : { integrations: settledIntegrations }) }),
    openApp: createNativeAppOpenClient((request) => ipcRenderer.invoke(NATIVE_APP_OPEN_CHANNEL, request)),
    openChat: createNativeAppOpenChatClient((request) => ipcRenderer.invoke(NATIVE_APP_OPEN_CHAT_CHANNEL, request)),
    generate: createAppGenerateClient((context) => ipcRenderer.invoke(APP_GENERATE_CHANNEL, context)),
    ai: createAppAiClient((input) => ipcRenderer.invoke(APP_AI_CHANNEL, input), () => ipcRenderer.invoke(APP_AI_ROUTES_CHANNEL, {})),
    files: createNativeAppFilesBridge({
      invokeFiles: (input) => ipcRenderer.invoke(APP_FILES_CHANNEL, input),
      invokeOpenRequest: (request) => ipcRenderer.invoke(NATIVE_APP_OPEN_REQUEST_CHANNEL, request),
      watchOpenRequests: (check) => watchOpenRequestSignals(window, check),
    }),
    // Advertise only capabilities this view can use. Other apps retain the
    // pre-#1624 surface so feature detection does not select an unusable API.
    ...((process.argv.includes(NATIVE_APP_ACTIVITY_BRIDGE_ARG) || process.argv.includes(NATIVE_APP_GALLERY_BRIDGE_ARG) || process.argv.includes(NATIVE_APP_BROWSER_BRIDGE_ARG)) ? {
      gatewayFetch: createNativeAppGatewayFetch((request) => ipcRenderer.invoke(NATIVE_APP_GATEWAY_CHANNEL, request)),
    } : {}),
    ...(process.argv.includes(NATIVE_APP_BROWSER_BRIDGE_ARG) ? { browserSetup: true } : {}),
    ...(ownerIntegrations ? {
      integrations: createNativeAppIntegrations((request) => ipcRenderer.invoke(NATIVE_APP_GATEWAY_CHANNEL, request)),
    } : {}),
  }));
  // Electron freezes values copied through contextBridge. Construct a public
  // wrapper in the page world so only the participant field can track sharing.
  contextBridge.executeInMainWorld({
    func: (participant) => {
      type FileResult = { ok: boolean; value?: unknown; code?: string; message?: string };
      type CapabilityResult = { ok: boolean; value?: unknown; status?: number; invalid?: boolean };
      const { capabilityResults, ...native } = (window as unknown as { __matrixNativeBridge: {
        collaboration: Record<string, unknown>; files: Record<string, (...args: unknown[]) => Promise<FileResult>>;
        capabilityResults: Record<string, (...args: unknown[]) => Promise<CapabilityResult>>;
      } }).__matrixNativeBridge;
      // The same for integration calls: a safe gateway status reaches the app as `error.status`.
      const settleCapability = (result: CapabilityResult) => {
        if (result?.ok) return result.value;
        const error = new Error(result?.invalid ? "Invalid app capability request" : "App integrations are unavailable");
        error.name = "AppCapabilityRequestError";
        throw typeof result?.status === "number" ? Object.assign(error, { status: result.status }) : error;
      };
      const capabilityCalls = Object.fromEntries(Object.keys(capabilityResults).map((method) =>
        [method, (...args: unknown[]) => capabilityResults[method]!(...args).then(settleCapability)]));
      // contextBridge drops an error's name and code, so the preload returns a
      // result and the page world throws the BridgeFileError shape from it.
      const settle = (result: FileResult) => {
        if (result?.ok) return result.value;
        const error = Object.assign(new Error(result?.message || "File access is unavailable"), { code: result?.code || "unavailable" });
        error.name = "BridgeFileError";
        throw error;
      };
      const files = Object.freeze({ ...native.files, ...Object.fromEntries(["list", "stat", "read", "write", "mkdir"].map((method) =>
        [method, (...args: unknown[]) => native.files[method]!(...args).then(settle)])) });
      Object.defineProperty(window, "MatrixOS", {
        value: Object.freeze({ ...native, ...capabilityCalls, files, collaboration: { ...native.collaboration, participant } }),
        configurable: false, writable: false,
      });
    },
    args: [ownerParticipant],
  });
} else {
  contextBridge.exposeInMainWorld("operator", api);
}
