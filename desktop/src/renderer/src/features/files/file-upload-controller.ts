import {
  createSelectedFileUploadController,
  SELECTED_UPLOAD_TIMEOUT_MS,
  SelectedUploadError,
  type SelectedUploadRow,
} from "@matrix-os/contracts/file-upload";
import type { ApiClient } from "../../lib/api";
import { AppError } from "../../lib/errors";

export type FileUploadRow = SelectedUploadRow;

/** Electron uses the same bounds, queue and state transitions as every Web view. */
export function createFileUploadController(options: {
  api: ApiClient;
  getScope: () => string;
  onUploaded: (directory: string) => void;
}) {
  return createSelectedFileUploadController<File>({
    getScope: options.getScope,
    onUploaded: options.onUploaded,
    upload: async (file, path, signal) => {
      try {
        return await options.api.putBytes<{ path: string }>(
          `/api/files/blob?path=${encodeURIComponent(path)}`,
          file,
          { "content-type": file.type || "application/octet-stream" },
          { timeoutMs: SELECTED_UPLOAD_TIMEOUT_MS, signal },
        );
      } catch (error: unknown) {
        if (error instanceof AppError && error.detail === "file_exists") throw new SelectedUploadError("file_exists");
        throw new SelectedUploadError("unavailable");
      }
    },
  });
}
