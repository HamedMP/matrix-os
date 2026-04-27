"use client";

import { useEffect, useState, useCallback } from "react";
import { useFileWatcherPattern } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";

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
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: number;
    tool?: string;
    toolInput?: Record<string, unknown>;
  }>;
}

const GATEWAY_URL = getGatewayUrl();

const CONV_PATTERN = /^system\/conversations\//;

async function fetchConversations(): Promise<ConversationMeta[]> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return res.json();
  } catch (err: unknown) {
    console.warn("[conversation] Failed to fetch conversations:", err instanceof Error ? err.message : String(err));
  }
  return [];
}

async function fetchConversation(
  id: string,
): Promise<ConversationFile | null> {
  try {
    const res = await fetch(
      `${GATEWAY_URL}/files/system/conversations/${id}.json`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (res.ok) return res.json();
  } catch (err: unknown) {
    console.warn("[conversation] Failed to fetch conversation:", err instanceof Error ? err.message : String(err));
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
