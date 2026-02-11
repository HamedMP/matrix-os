"use client";

import { useEffect, useState, useCallback } from "react";
import { useFileWatcherPattern } from "./useFileWatcher";

interface ConversationMeta {
  id: string;
  preview: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
}

interface ConversationFile {
  id: string;
  createdAt: number;
  updatedAt: number;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
}

const GATEWAY_URL =
  process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:4000";

const CONV_PATTERN = /^system\/conversations\//;

async function fetchConversations(): Promise<ConversationMeta[]> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/conversations`);
    if (res.ok) return res.json();
  } catch {
    // gateway not available
  }
  return [];
}

async function fetchConversation(
  id: string,
): Promise<ConversationFile | null> {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/files/system/conversations/${id}.json`,
    );
    if (res.ok) return res.json();
  } catch {
    // gateway not available
  }
  return null;
}

export function useConversation() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);

  const refresh = useCallback(() => {
    fetchConversations().then(setConversations);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFileWatcherPattern(CONV_PATTERN, useCallback(() => {
    refresh();
  }, [refresh]));

  const load = useCallback(async (id: string) => {
    return fetchConversation(id);
  }, []);

  return { conversations, load, refresh };
}
