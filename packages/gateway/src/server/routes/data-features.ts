/** Owner data feature routes: messaging, canvas and the message board (route group `data-features`). */
import type { Hono } from "hono";
import type { createNodeWebSocket } from "@hono/node-ws";
import type { CanvasService } from "../../canvas/service.js";
import type { CanvasSubscriptionHub } from "../../canvas/subscriptions.js";
import type { GatewayCollaborationRuntime } from "../../collaboration/wiring.js";
import type { MessageBoardRuntime } from "../../message-board/runtime.js";
import { registerCanvasGatewayRoutes } from "../canvas-gateway-routes.js";
import {
  boardTerminalCaller, configureMessageBoardAutomation, registerMessageBoardGatewayRoutes, type BoardTerminalAgents,
} from "../message-board-gateway-routes.js";
import { registerGatewayMessagingRoutes } from "../owner-data-routes.js";

export interface DataFeatureRouteOptions {
  app: Hono;
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"];
  messagingRepository: Parameters<typeof registerGatewayMessagingRoutes>[1];
  canvasService: CanvasService | null;
  canvasSubscriptionHub: CanvasSubscriptionHub | null;
  gatewayCollaboration: GatewayCollaborationRuntime | null;
  messageBoard: MessageBoardRuntime | null;
  ownerName?: string;
  /** Spec 2692 terminal agents: identifies a calling pane and starts watcher sessions. */
  terminalAgents?: BoardTerminalAgents;
  push?: Parameters<typeof configureMessageBoardAutomation>[1]["push"];
  logUnexpectedWsSendFailure(context: string, error: unknown): void;
}

export function registerDataFeatureRoutes(options: DataFeatureRouteOptions): void {
  const { app, upgradeWebSocket } = options;
  registerGatewayMessagingRoutes(app, options.messagingRepository);
  registerMessageBoardGatewayRoutes({
    app, upgradeWebSocket, runtime: options.messageBoard, ownerName: options.ownerName,
    ...(options.terminalAgents ? { resolveTerminalCaller: boardTerminalCaller(options.terminalAgents) } : {}),
  });
  configureMessageBoardAutomation(options.messageBoard, {
    runTerminalAgent: options.terminalAgents ? (input) => options.terminalAgents!.kernelTools.run(input) : undefined,
    listTerminals: options.terminalAgents ? () => options.terminalAgents!.kernelTools.list() : undefined,
    push: options.push,
    ownerHandles: options.ownerName ? [options.ownerName] : [],
  });
  registerCanvasGatewayRoutes({
    app, upgradeWebSocket, canvasService: options.canvasService, canvasSubscriptionHub: options.canvasSubscriptionHub,
    gatewayCollaboration: options.gatewayCollaboration, logUnexpectedWsSendFailure: options.logUnexpectedWsSendFailure,
  });
}
