"use client";

import { useState, useEffect } from "react";
import { ChannelCard } from "@/components/settings/ChannelCard";
import { getGatewayUrl } from "@/lib/gateway";
import {
  MessageSquareIcon,
  SmartphoneIcon,
  HashIcon,
  SlackIcon,
} from "lucide-react";

const GATEWAY = getGatewayUrl();

const CHANNEL_DEFS = [
  {
    id: "telegram",
    name: "Telegram",
    icon: <MessageSquareIcon className="size-5 text-blue-500" />,
    fields: [
      { key: "token", label: "Bot Token", placeholder: "123456:ABC-DEF..." },
      { key: "allowFrom", label: "Allow From (comma-separated user IDs)", placeholder: "123456,789012" },
    ],
  },
  {
    id: "discord",
    name: "Discord",
    icon: <HashIcon className="size-5 text-indigo-500" />,
    fields: [
      { key: "token", label: "Bot Token", placeholder: "MTI3NjU..." },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    icon: <SlackIcon className="size-5 text-purple-500" />,
    fields: [
      { key: "botToken", label: "Bot Token", placeholder: "xoxb-..." },
      { key: "appToken", label: "App Token", placeholder: "xapp-..." },
    ],
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: <SmartphoneIcon className="size-5 text-green-500" />,
    fields: [
      { key: "authDir", label: "Auth Directory", placeholder: "system/whatsapp-auth" },
    ],
  },
];

export default function ChannelsPage() {
  const [statuses, setStatuses] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`${GATEWAY}/api/channels/status`)
      .then((r) => r.ok ? r.json() : {})
      .then(setStatuses)
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-3xl mx-auto p-6 space-y-6">
      <h2 className="text-lg font-semibold">Channels</h2>
      <p className="text-sm text-muted-foreground">
        Configure messaging channels to interact with your agent from external platforms.
      </p>

      <div className="space-y-3">
        {CHANNEL_DEFS.map((ch) => (
          <ChannelCard
            key={ch.id}
            id={ch.id}
            name={ch.name}
            icon={ch.icon}
            status={statuses[ch.id] ?? "not configured"}
            fields={ch.fields}
          />
        ))}
      </div>
    </div>
  );
}
