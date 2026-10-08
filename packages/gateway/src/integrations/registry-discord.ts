import type { ServiceDefinition } from "./types.js";
import { listValidation } from "./list-validation.js";
import { INTEGRATION_LOGOS } from "./registry-logos.js";

// Discord snowflakes are 17-20 digit numeric strings. Strict numeric check
// refuses path traversal and any non-digit input before we interpolate it
// into a real Discord API URL.
const DISCORD_SNOWFLAKE_RE = /^\d{17,20}$/;
function encodeDiscordSnowflake(value: unknown): string {
  if (typeof value !== "string" || !DISCORD_SNOWFLAKE_RE.test(value)) {
    throw new Error(`Discord ID must be a 17-20 digit numeric string, got: ${String(value)}`);
  }
  return value;
}

// Connector identity is the capability boundary; OAuth scopes never imply a bot token.
export const DISCORD_SERVICE_REGISTRY: Record<string, ServiceDefinition> = {
  discord: {
    id: "discord", name: "Discord", category: "communication",
    pipedreamApp: "discord", connectorKind: "pipedream", icon: "message-circle",
    logoUrl: INTEGRATION_LOGOS.discord,
    actions: {
      list_servers: {
        description: "List servers the user is in",
        risk: "read",
        paramsSchema: listValidation.servers,
        params: {
          before: { type: "string" },
          after: { type: "string" },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://discord.com/api/v10/users/@me/guilds",
          mapParams: (p) => ({
            ...(p.before !== undefined ? { before: String(p.before) } : {}),
            ...(p.after !== undefined ? { after: String(p.after) } : {}),
            ...(p.limit !== undefined ? { limit: String(p.limit) } : {}),
          }),
        },
      },
    },
  },
  discord_bot: {
    id: "discord_bot",
    name: "Discord Bot",
    category: "communication",
    pipedreamApp: "discord_bot",
    icon: "message-circle",
    logoUrl: INTEGRATION_LOGOS.discord,
    connectorKind: "pipedream",
    actions: {
      // Discord REST: POST /channels/{channel.id}/messages. Requires the bot
      // to have SEND_MESSAGES permission on the channel. Snowflake is
      // strictly validated before interpolation.
      send_message: {
        description: "Send a message to a channel",
        risk: "write",
        params: {
          channelId: { type: "string", required: true },
          content: { type: "string", required: true },
        },
        directApi: {
          method: "POST",
          url: (p) =>
            `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
          mapBody: (p) => ({ content: String(p.content) }),
        },
      },
      // GET /users/@me/guilds returns the list of servers (guilds) the
      // authenticated bot is a member of, using its separate bot credential.
      list_servers: {
        description: "List servers the bot is in",
        risk: "read",
        paramsSchema: listValidation.servers,
        params: {
          before: { type: "string" },
          after: { type: "string" },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: "https://discord.com/api/v10/users/@me/guilds",
          mapParams: (p) => ({
            ...(p.before !== undefined ? { before: String(p.before) } : {}),
            ...(p.after !== undefined ? { after: String(p.after) } : {}),
            ...(p.limit !== undefined ? { limit: String(p.limit) } : {}),
          }),
        },
      },
      // GET /guilds/{guild.id}/channels. Requires bot membership with
      // VIEW_CHANNEL permission.
      list_channels: {
        description: "List channels in a server",
        risk: "read",
        params: {
          serverId: { type: "string", required: true },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://discord.com/api/v10/guilds/${encodeDiscordSnowflake(p.serverId)}/channels`,
        },
      },
      // GET /channels/{channel.id}/messages. Returns most recent first.
      list_messages: {
        description: "List messages in a channel",
        risk: "read",
        paramsSchema: listValidation.discordMessages,
        params: {
          before: { type: "string" },
          after: { type: "string" },
          channelId: { type: "string", required: true },
          limit: { type: "number" },
        },
        directApi: {
          method: "GET",
          url: (p) =>
            `https://discord.com/api/v10/channels/${encodeDiscordSnowflake(p.channelId)}/messages`,
          mapParams: (p) => ({
            ...(p.before !== undefined ? { before: String(p.before) } : {}),
            ...(p.after !== undefined ? { after: String(p.after) } : {}),
            limit: p.limit ? String(Math.min(100, Number(p.limit))) : "20",
          }),
        },
      },
    },
  },
};

export class DiscordBotRequiredError extends Error {
  constructor() {
    super("Discord bot connection required");
    this.name = "DiscordBotRequiredError";
  }
}

export function assertDiscordCapability(service: string, action: string): void {
  if (service === "discord" && action !== "list_servers"
    && Object.hasOwn(DISCORD_SERVICE_REGISTRY.discord_bot.actions, action)) {
    throw new DiscordBotRequiredError();
  }
}

/** A successful HTTP status alone must not clear an agent's discovery failure fence. */
export function validateDiscordChannelDiscovery(data: unknown): void {
  if (!Array.isArray(data) || data.some(channel => !channel || typeof channel !== "object"
    || typeof channel.id !== "string" || !DISCORD_SNOWFLAKE_RE.test(channel.id))) {
    throw new Error("Invalid Discord channel discovery response");
  }
}
