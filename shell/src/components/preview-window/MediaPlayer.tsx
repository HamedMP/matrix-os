"use client";

import { getGatewayUrl } from "@/lib/gateway";

const GATEWAY_URL = getGatewayUrl();

interface MediaPlayerProps {
  path: string;
  type: "audio" | "video";
}

export function MediaPlayer({ path, type }: MediaPlayerProps) {
  const url = `${GATEWAY_URL}/files/${path}`;

  if (type === "audio") {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <audio controls className="w-full max-w-md" src={url} />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center h-full p-4">
      <video controls className="max-w-full max-h-full" src={url} />
    </div>
  );
}
