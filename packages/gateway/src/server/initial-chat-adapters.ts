import type { OpenClawRpcClient } from "../agent-config/openclaw-rpc.js";
import { createKernelChatProviderAdapter } from "../chat/kernel-provider-adapter.js";
import { createHermesChatProviderAdapter } from "../chat/hermes-provider-adapter.js";
import { createOpenClawChatProviderAdapter } from "../chat/openclaw-provider-adapter.js";
import type { CanonicalChatProviderAdapter } from "../chat/provider-adapter.js";
import type { SharedBrowserBroker } from "../shared-browser/broker.js";

/** Keep native browser dependencies in one composition path for all Chat adapters. */
export function createInitialChatAdapters(options:{
  homePath:string;dispatcher:Parameters<typeof createKernelChatProviderAdapter>[0]["dispatcher"];toolOutputKey?:Buffer;rpc:OpenClawRpcClient;
  jev?:Parameters<typeof createHermesChatProviderAdapter>[0]["jev"];
  routineCli?:Parameters<typeof createHermesChatProviderAdapter>[0]["routineCli"];
  sharedBrowser?:SharedBrowserBroker;gatewayPort:number;
}):CanonicalChatProviderAdapter[] {
  const shared=options.sharedBrowser?{sharedBrowser:options.sharedBrowser,sharedBrowserGatewayPort:options.gatewayPort}:{};
  return[
    createKernelChatProviderAdapter({dispatcher:options.dispatcher}),
    createHermesChatProviderAdapter({homePath:options.homePath,toolOutputKey:options.toolOutputKey,
      ...(options.routineCli?{routineCli:options.routineCli}:{}),
      ...(options.jev?{jev:options.jev}:{}),...shared}),
    createOpenClawChatProviderAdapter({rpc:options.rpc,homePath:options.homePath,...shared}),
  ];
}
