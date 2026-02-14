export { createGateway } from "./server.js";
export type { GatewayConfig } from "./server.js";
export { createDispatcher } from "./dispatcher.js";
export type { Dispatcher, DispatchOptions, DispatchContext, SpawnFn } from "./dispatcher.js";
export { createWatcher } from "./watcher.js";
export type { Watcher, FileChangeEvent, FileEvent } from "./watcher.js";
export { createPtyHandler } from "./pty.js";
export type { PtyMessage, PtyServerMessage } from "./pty.js";
export { createChannelManager } from "./channels/manager.js";
export type { ChannelManager, ChannelManagerConfig } from "./channels/manager.js";
export { createTelegramAdapter } from "./channels/telegram.js";
export { formatForChannel } from "./channels/format.js";
export type {
  ChannelAdapter,
  ChannelConfig,
  ChannelId,
  ChannelMessage,
  ChannelReply,
} from "./channels/types.js";
