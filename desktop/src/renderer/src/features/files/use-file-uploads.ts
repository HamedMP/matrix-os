import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient } from "../../lib/api";
import { createFileUploadController, type FileUploadRow } from "./file-upload-controller";

export function useFileUploads({
  api,
  browserScope,
  currentPath,
  enabled,
  onUploaded,
}: {
  api: ApiClient | null;
  browserScope: string;
  currentPath: string;
  enabled: boolean;
  onUploaded: (directory: string) => void;
}) {
  const controllerRef = useRef<ReturnType<typeof createFileUploadController> | null>(null);
  const currentPathRef = useRef(currentPath);
  const [uploads, setUploads] = useState<FileUploadRow[]>([]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    if (!api || !enabled) {
      controllerRef.current = null;
      setUploads([]);
      return;
    }
    const controller = createFileUploadController({
      api,
      getScope: () => browserScope,
      onUploaded: (directory) => {
        if (directory === currentPathRef.current) onUploaded(directory);
      },
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setUploads);
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null;
      unsubscribe();
      controller.dispose();
    };
  }, [api, browserScope, enabled, onUploaded]);

  const enqueue = useCallback((files: readonly File[], destination: string) => {
    controllerRef.current?.enqueue(files, destination);
  }, []);
  const retry = useCallback((id: string) => controllerRef.current?.retry(id), []);
  const remove = useCallback((id: string) => controllerRef.current?.remove(id), []);

  return { uploads, enqueue, retry, remove };
}
