"use client";

import { useMemo } from "react";
import { parseContentSegments, type UICardData, type UIOptionData } from "@/lib/ui-blocks";
import { MessageResponse } from "@/components/ai-elements/message";
import { CardGrid } from "./CardGrid";
import { OptionList } from "./OptionList";
import { StatusBanner } from "./StatusBanner";

interface RichContentProps {
  children: string;
  onAction?: (text: string) => void;
}

export function RichContent({ children, onAction }: RichContentProps) {
  const segments = useMemo(
    () => parseContentSegments(children),
    [children],
  );

  if (segments.length === 1 && segments[0].type === "markdown") {
    return <MessageResponse>{children}</MessageResponse>;
  }

  return (
    <>
      {segments.map((seg, i) => {
        switch (seg.type) {
          case "markdown":
            return <MessageResponse key={i}>{seg.content}</MessageResponse>;
          case "ui:cards":
            return (
              <CardGrid
                key={i}
                cards={seg.data}
                onSelect={(card: UICardData) =>
                  onAction?.(card.title)
                }
              />
            );
          case "ui:options":
            return (
              <OptionList
                key={i}
                options={seg.data}
                onSelect={(opt: UIOptionData) =>
                  onAction?.(opt.value ?? opt.label)
                }
              />
            );
          case "ui:status":
            return <StatusBanner key={i} status={seg.data} />;
        }
      })}
    </>
  );
}
