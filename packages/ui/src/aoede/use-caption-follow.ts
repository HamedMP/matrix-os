"use client";
import { useLayoutEffect, useRef, type UIEvent } from "react";
import type { AoedePanelProps } from "./AoedePanel.js";
/** Follow live text unless the reader scrolls up; a new Chat starts at its latest caption. */
export function useCaptionFollow(conversationKey: string | undefined, text: AoedePanelProps["captions"]) {
  const captions = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const conversation = useRef(conversationKey);
  useLayoutEffect(() => {
    if (conversation.current !== conversationKey) {
      conversation.current = conversationKey;
      follow.current = true;
    }
    const node = captions.current;
    if (node && follow.current) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
  }, [conversationKey, text.utterance, text.response, text.interrupted]);
  const onCaptionScroll = (event: UIEvent<HTMLDivElement>) => {
    const node = event.currentTarget;
    follow.current = node.scrollHeight - node.clientHeight - node.scrollTop <= 32;
  };
  return { captions, onCaptionScroll };
}
