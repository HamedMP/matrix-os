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

import { APP_CAPABILITY_CHANNEL, createNativeAppCapabilityClient } from "../shared/native-app-capabilities";
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
  contextBridge.exposeInMainWorld("__matrixNativeBridge", Object.freeze({
    db: database,
    collaboration,
    ...createNativeAppCapabilityClient((input) => ipcRenderer.invoke(APP_CAPABILITY_CHANNEL, input)),
    openApp: createNativeAppOpenClient((request) => ipcRenderer.invoke(NATIVE_APP_OPEN_CHANNEL, request)),
    openChat: createNativeAppOpenChatClient((request) => ipcRenderer.invoke(NATIVE_APP_OPEN_CHAT_CHANNEL, request)),
    generate: createAppGenerateClient((context) => ipcRenderer.invoke(APP_GENERATE_CHANNEL, context)),
    ai: createAppAiClient((input) => ipcRenderer.invoke(APP_AI_CHANNEL, input), () => ipcRenderer.invoke(APP_AI_ROUTES_CHANNEL, {})),
    // Advertise only capabilities this view can use. Other apps retain the
    // pre-#1624 surface so feature detection does not select an unusable API.
    ...((process.argv.includes(NATIVE_APP_ACTIVITY_BRIDGE_ARG) || process.argv.includes(NATIVE_APP_GALLERY_BRIDGE_ARG) || process.argv.includes(NATIVE_APP_BROWSER_BRIDGE_ARG)) ? {
      gatewayFetch: createNativeAppGatewayFetch((request) => ipcRenderer.invoke(NATIVE_APP_GATEWAY_CHANNEL, request)),
    } : {}),
    ...(process.argv.includes(NATIVE_APP_BROWSER_BRIDGE_ARG) ? { browserSetup: true } : {}),
    ...(process.argv.includes(NATIVE_APP_INTEGRATIONS_BRIDGE_ARG) ? {
      integrations: createNativeAppIntegrations((request) => ipcRenderer.invoke(NATIVE_APP_GATEWAY_CHANNEL, request)),
    } : {}),
  }));
  // Electron freezes values copied through contextBridge. Construct a public
  // wrapper in the page world so only the participant field can track sharing.
  contextBridge.executeInMainWorld({
    func: (participant) => {
      const native = (window as unknown as { __matrixNativeBridge: { collaboration: Record<string, unknown> } }).__matrixNativeBridge;
      Object.defineProperty(window, "MatrixOS", {
        value: Object.freeze({ ...native, collaboration: { ...native.collaboration, participant } }),
        configurable: false, writable: false,
      });
    },
    args: [ownerParticipant],
  });
} else {
  contextBridge.exposeInMainWorld("operator", api);
}
