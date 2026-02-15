"use client";

import { useEffect, useState, useCallback } from "react";
import { useSocket, type ServerMessage } from "./useSocket";
import { getGatewayUrl } from "@/lib/gateway";

export interface TaskItem {
  id: string;
  type: string;
  status: string;
  input: string;
  output?: string;
  assignedTo?: string;
  priority?: number;
  createdAt?: string;
  claimedAt?: string;
  completedAt?: string;
  appName?: string;
}

export interface ProvisionStatus {
  active: boolean;
  total: number;
  succeeded: number;
  failed: number;
}

const GATEWAY_URL = getGatewayUrl();

function parseAppName(input: string): string | undefined {
  try {
    const parsed = JSON.parse(input);
    return parsed.app ?? parsed.message ?? undefined;
  } catch {
    return undefined;
  }
}

export function useTaskBoard() {
  const { subscribe } = useSocket();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [provision, setProvision] = useState<ProvisionStatus>({
    active: false,
    total: 0,
    succeeded: 0,
    failed: 0,
  });
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${GATEWAY_URL}/api/tasks`)
      .then((res) => res.json())
      .then((data: TaskItem[]) => {
        setTasks(
          data.map((t) => ({
            ...t,
            appName: parseAppName(t.input),
          })),
        );
      })
      .catch(() => {});
  }, []);

  const handleMessage = useCallback((msg: ServerMessage) => {
    if (msg.type === "task:created") {
      setTasks((prev) => [
        ...prev,
        {
          ...msg.task,
          appName: parseAppName(msg.task.input),
        },
      ]);
    } else if (msg.type === "task:updated") {
      setTasks((prev) =>
        prev.map((t) =>
          t.id === msg.taskId ? { ...t, status: msg.status } : t,
        ),
      );
    } else if (msg.type === "provision:start") {
      setProvision({
        active: true,
        total: msg.appCount,
        succeeded: 0,
        failed: 0,
      });
    } else if (msg.type === "provision:complete") {
      setProvision({
        active: false,
        total: msg.total,
        succeeded: msg.succeeded,
        failed: msg.failed,
      });
    }
  }, []);

  useEffect(() => {
    return subscribe(handleMessage);
  }, [subscribe, handleMessage]);

  const selectTask = useCallback((id: string | null) => {
    setSelectedTaskId(id);
  }, []);

  const addTask = useCallback(async (input: string) => {
    await fetch(`${GATEWAY_URL}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "todo", input }),
    });
  }, []);

  const todo = tasks.filter((t) => t.status === "pending");
  const inProgress = tasks.filter((t) => t.status === "in_progress");
  const done = tasks.filter(
    (t) => t.status === "completed" || t.status === "failed",
  );

  return { tasks, provision, todo, inProgress, done, selectedTaskId, selectTask, addTask };
}
