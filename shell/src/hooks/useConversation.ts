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

function logConversationFetchError(label: string, err: unknown): void {
  if (process.env.NODE_ENV !== "production") {
    console.debug(label, err instanceof Error ? err.message : String(err));
  }
}

async function fetchConversations(): Promise<ConversationMeta[]> {
  try {
    const res = await fetch(`${GATEWAY_URL}/api/conversations`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return res.json();
  } catch (err: unknown) {
    logConversationFetchError("[conversation] Failed to fetch conversations:", err);
  }
  return [];
}

async function fetchConversation(
  id: string,
): Promise<ConversationFile | null> {
  try {
    const res = await fetch(`${GATEWAY_URL}/files/system/conversations/${id}.json`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return res.json();
  } catch (err: unknown) {
    logConversationFetchError("[conversation] Failed to fetch conversation:", err);
  }
  return null;
}

export function useConversation() {
  const [conversations, setConversations] = useState<ConversationMeta[]>([]);

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const refresh = useCallback(() => {
    fetchConversations().then(setConversations);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useFileWatcherPattern(
    CONV_PATTERN,
    () => {
      refresh();
    },
  );

  // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
  const load = useCallback(async (id: string) => {
    return fetchConversation(id);
  }, []);

  return { conversations, load, refresh };
}
