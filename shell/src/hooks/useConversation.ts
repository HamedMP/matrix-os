"use client";

import { useEffect, useState, useCallback } from "react";
import { useFileWatcherPattern } from "./useFileWatcher";
import { getGatewayUrl } from "@/lib/gateway";
import type { KernelConversationContextProjection, KernelConversationSummary } from "@matrix-os/contracts";

export type ConversationMeta = KernelConversationSummary;

interface ConversationFile {
  id: string;
  createdAt: number;
  updatedAt: number;
  context?: KernelConversationContextProjection;
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

  const remove = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`${GATEWAY_URL}/api/conversations/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      setConversations((current) => current.filter((conversation) => conversation.id !== id));
      return true;
    } catch (err: unknown) {
      logConversationFetchError("[conversation] Failed to delete conversation:", err);
      return false;
    }
  }, []);

  const setProjectContext = useCallback(async (id: string, projectId: string): Promise<boolean> => {
    try {
      const response = await fetch(`${GATEWAY_URL}/api/conversations/${encodeURIComponent(id)}/context`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      refresh();
      return true;
    } catch (err: unknown) {
      logConversationFetchError("[conversation] Failed to set project context:", err);
      return false;
    }
  }, [refresh]);

  return { conversations, load, refresh, remove, setProjectContext };
}
