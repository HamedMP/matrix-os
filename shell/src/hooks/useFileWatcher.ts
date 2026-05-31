"use client";

import { useEffect, useRef, useCallback } from "react";
import { useSocket, type ServerMessage } from "./useSocket";

export type FileChangeHandler = (path: string, event: "add" | "change" | "unlink") => void;

export function useFileWatcher(handler: FileChangeHandler) {
  const { subscribe } = useSocket();
  const handlerRef = useRef(handler);
  // react-doctor-disable-next-line react-hooks-js/refs -- latest-value mirror of handler, read inside the file:change subscription that is registered once via a stable subscribe; writing it in render keeps the mirror current so the watcher always invokes the newest handler without re-subscribing on every render
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
    // react-doctor-disable-next-line react-doctor/react-compiler-no-manual-memoization -- returned hook API / stable identity for effect dep
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
