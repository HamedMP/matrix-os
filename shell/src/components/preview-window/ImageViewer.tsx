"use client";

import { useState } from "react";
import { getGatewayUrl } from "@/lib/gateway";
import { Button } from "@/components/ui/button";
import { MinusIcon, PlusIcon, MaximizeIcon } from "lucide-react";

const GATEWAY_URL = getGatewayUrl();

interface ImageViewerProps {
  path: string;
}

export function ImageViewer({ path }: ImageViewerProps) {
  const [zoom, setZoom] = useState(100);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-3 py-1 border-b text-xs text-muted-foreground">
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setZoom((z) => Math.max(10, z - 25))}
        >
          <MinusIcon className="size-3" />
        </Button>
        <span className="w-12 text-center">{zoom}%</span>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setZoom((z) => Math.min(500, z + 25))}
        >
          <PlusIcon className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={() => setZoom(100)}
          title="Fit"
        >
          <MaximizeIcon className="size-3" />
        </Button>
      </div>
      <div
        className="flex-1 overflow-auto flex items-center justify-center"
        style={{
          backgroundImage:
            "linear-gradient(45deg, #333 25%, transparent 25%), linear-gradient(-45deg, #333 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #333 75%), linear-gradient(-45deg, transparent 75%, #333 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0px",
        }}
      >
        <img
          src={`${GATEWAY_URL}/files/${path}`}
          alt={path.split("/").pop()}
          style={{
            width: `${zoom}%`,
            maxWidth: "none",
            objectFit: "contain",
          }}
          draggable={false}
        />
      </div>
    </div>
  );
}
