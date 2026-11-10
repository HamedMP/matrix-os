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

const NATIVE_APP_BRIDGE_ARG = "--matrix-app-bridge";

// The Terminal window loads this same preload (a sandboxed preload is one
// bundled entry) but is given only its allowlisted channels.
const api = createOperatorBridge(
  ipcRenderer,
  process.argv.includes(TERMINAL_WINDOW_ARG) ? "terminal" : "main",
);

export type OperatorBridge = typeof api;

if (process.argv.includes(NATIVE_APP_BRIDGE_ARG)) {
  const database = createNativeAppDatabase((query: NativeAppQuery) =>
    ipcRenderer.invoke(NATIVE_APP_QUERY_CHANNEL, query));
  contextBridge.exposeInMainWorld("MatrixOS", Object.freeze({
    db: database,
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
} else {
  contextBridge.exposeInMainWorld("operator", api);
}
