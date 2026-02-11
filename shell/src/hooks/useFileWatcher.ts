"use client";

import { useEffect, useRef, useCallback } from "react";
import { useSocket, type ServerMessage } from "./useSocket";

export type FileChangeHandler = (path: string, event: "add" | "change" | "unlink") => void;

export function useFileWatcher(handler: FileChangeHandler) {
  const { subscribe } = useSocket();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (msg.type === "file:change") {
        handlerRef.current(msg.path, msg.event);
      }
    });
  }, [subscribe]);
}

export function useFileWatcherPattern(
  pattern: RegExp,
  handler: FileChangeHandler,
) {
  useFileWatcher(
    useCallback(
      (path, event) => {
        if (pattern.test(path)) {
          handler(path, event);
        }
      },
      [pattern, handler],
    ),
  );
}
