export type ChannelId = "telegram" | "whatsapp" | "discord" | "slack";

export interface ChannelMessage {
  source: ChannelId;
  senderId: string;
  senderName?: string;
  text: string;
  chatId: string;
  replyToId?: string;
}

export interface ChannelReply {
  channelId: ChannelId;
  chatId: string;
  text: string;
  replyToId?: string;
}

export interface ChannelConfig {
  enabled: boolean;
  token?: string;
  botToken?: string;
  appToken?: string;
  authDir?: string;
  allowFrom?: string[];
}

export interface ChannelAdapter {
  readonly id: ChannelId;
  start(config: ChannelConfig): Promise<void>;
  stop(): Promise<void>;
  send(reply: ChannelReply): Promise<void>;
  onMessage: (msg: ChannelMessage) => void;
}
