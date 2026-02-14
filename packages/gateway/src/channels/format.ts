import type { ChannelId } from "./types.js";

const TELEGRAM_ESCAPE = /([_*\[\]()~`>#+\-=|{}.!$\\])/g;

function toTelegramMarkdownV2(text: string): string {
  if (!text) return "";

  const preserved: string[] = [];
  let idx = 0;

  function preserve(content: string): string {
    preserved.push(content);
    return `\x00${idx++}\x00`;
  }

  let result = text;

  result = result.replace(/```([\s\S]*?)```/g, (_, code) =>
    preserve(`\`\`\`${code}\`\`\``),
  );

  result = result.replace(/`([^`]+)`/g, (_, code) =>
    preserve(`\`${code}\``),
  );

  result = result.replace(/\*\*(.+?)\*\*/g, (_, content) =>
    preserve(`*${content.replace(TELEGRAM_ESCAPE, "\\$1")}*`),
  );

  result = result.replace(/_(.+?)_/g, (_, content) =>
    preserve(`_${content.replace(TELEGRAM_ESCAPE, "\\$1")}_`),
  );

  result = result.replace(TELEGRAM_ESCAPE, "\\$1");

  for (let i = 0; i < preserved.length; i++) {
    result = result.replace(`\x00${i}\x00`, preserved[i]);
  }

  return result;
}

function toSlackMrkdwn(text: string): string {
  if (!text) return "";

  let result = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  return result;
}

function toWhatsApp(text: string): string {
  if (!text) return "";

  let result = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  result = result.replace(/`([^`]+)`/g, "$1");

  return result;
}

export function formatForChannel(channelId: ChannelId, text: string): string {
  switch (channelId) {
    case "telegram":
      return toTelegramMarkdownV2(text);
    case "discord":
      return text;
    case "slack":
      return toSlackMrkdwn(text);
    case "whatsapp":
      return toWhatsApp(text);
  }
}
