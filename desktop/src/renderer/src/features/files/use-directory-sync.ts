import { useCallback, useEffect, useRef } from "react";
import type {
  FileDirectoryHandler,
  FileDirectoryServerMessage,
} from "../../lib/kernel-socket";

export const DIRECTORY_CHANGE_DEBOUNCE_MS = 150;

export interface DirectorySyncSocket {
  subscribeDirectory(directory: string, handler: FileDirectoryHandler): () => void;
  touchDirectory(directory: string): boolean;
}

export interface DirectorySyncScope {
  runtimeSlot: string;
  authGeneration: number;
}

export interface UseDirectorySyncOptions<T> extends DirectorySyncScope {
  socket: DirectorySyncSocket;
  directory: string;
  loadDirectory(directory: string, scope: DirectorySyncScope): Promise<T>;
  onReconciled(value: T): void;
}

export interface DirectorySyncHandle {
  touch(): boolean;
}

export function useDirectorySync<T>(options: UseDirectorySyncOptions<T>): DirectorySyncHandle {
  const activeRef = useRef(false);

  useEffect(() => {
    let active = true;
    let revision: number | null = null;
    let reloadGeneration = 0;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    activeRef.current = true;
    const scope = {
      runtimeSlot: options.runtimeSlot,
      authGeneration: options.authGeneration,
    };

    const cancelDebounce = () => {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    };

    const reload = async () => {
      const generation = ++reloadGeneration;
      try {
        const value = await options.loadDirectory(options.directory, scope);
        if (!active || generation !== reloadGeneration) return;
        options.onReconciled(value);
      } catch (error: unknown) {
        if (!active || generation !== reloadGeneration) return;
        console.warn(
          "[directory-sync] authoritative reload failed:",
          error instanceof Error ? error.name : typeof error,
        );
      }
    };

    const reloadImmediately = () => {
      cancelDebounce();
      void reload();
    };

    const scheduleReload = () => {
      cancelDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        void reload();
      }, DIRECTORY_CHANGE_DEBOUNCE_MS);
    };

    const onMessage = (message: FileDirectoryServerMessage) => {
      if (!active) return;
      if (message.type === "files:shutdown") {
        revision = null;
        reloadImmediately();
        return;
      }
      if (message.directory !== options.directory) return;
      if (message.type === "files:subscribed") {
        revision = message.revision;
        reloadImmediately();
        return;
      }
      if (revision === null || message.revision !== revision + 1) {
        revision = message.revision;
        reloadImmediately();
        return;
      }
      revision = message.revision;
      scheduleReload();
    };

    const unsubscribe = options.socket.subscribeDirectory(options.directory, onMessage);
    return () => {
      active = false;
      activeRef.current = false;
      reloadGeneration++;
      cancelDebounce();
      unsubscribe();
    };
  }, [
    options.socket,
    options.directory,
    options.runtimeSlot,
    options.authGeneration,
    options.loadDirectory,
    options.onReconciled,
  ]);

  const touch = useCallback(() => {
    return activeRef.current && options.socket.touchDirectory(options.directory);
  }, [options.socket, options.directory, options.runtimeSlot, options.authGeneration]);

  return { touch };
}
