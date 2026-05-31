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
            // react-doctor-disable-next-line react-doctor/no-array-index-key, react-doctor/no-array-index-as-key -- rich-content markdown segments are an ordered parse of one immutable message; duplicate markdown text has no stable id, so position is the collision-free identity.
            return <MessageResponse key={`md:${i}`}>{seg.content}</MessageResponse>;
          case "ui:cards":
            return (
              <CardGrid
                key={`cards:${seg.data.map((c) => c.title).join("|")}`}
                cards={seg.data}
                onSelect={(card: UICardData) =>
                  onAction?.(card.title)
                }
              />
            );
          case "ui:options":
            return (
              <OptionList
                key={`options:${seg.data.map((o) => o.value ?? o.label).join("|")}`}
                options={seg.data}
                onSelect={(opt: UIOptionData) =>
                  onAction?.(opt.value ?? opt.label)
                }
              />
            );
          case "ui:status":
            return <StatusBanner key={`status:${seg.data.level}:${seg.data.message}`} status={seg.data} />;
        }
      })}
    </>
  );
}
