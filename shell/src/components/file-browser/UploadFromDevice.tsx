"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createSelectedFileUploadController,
  SELECTED_UPLOAD_TIMEOUT_MS,
  SelectedUploadError,
} from "@matrix-os/contracts/file-upload";

type Props = {
  identity: string;
  gatewayUrl: string;
  currentPath: string;
  onUploaded: (directory: string) => void;
};

function createUploadCallbacks(initial: Props["onUploaded"]) {
  let callback = initial;
  return {
    update(next: Props["onUploaded"]) { callback = next; },
    notify(directory: string) { callback(directory); },
  };
}

export function UploadFromDevice(props: Props) {
  // Remounting releases selections and aborts old requests when the owner or
  // selected runtime changes. The transport itself captures the exact URL.
  return <UploadFromDeviceSession key={`${props.identity}:${props.gatewayUrl}`} {...props} />;
}

function UploadFromDeviceSession({ identity, gatewayUrl, currentPath, onUploaded }: Props) {
  const { getToken } = useAuth();
  const [callbacks] = useState(() => createUploadCallbacks(onUploaded));
  useEffect(() => { callbacks.update(onUploaded); }, [callbacks, onUploaded]);
  const [controller] = useState(() => createSelectedFileUploadController<File>({
    getScope: () => identity,
    onUploaded: directory => callbacks.notify(directory),
    upload: async (file, path, signal) => {
      const token = await getToken();
      if (signal.aborted) throw new SelectedUploadError("unavailable");
      const url = `${gatewayUrl}/api/files/blob?path=${encodeURIComponent(path)}`;
      const timeout = AbortSignal.timeout(SELECTED_UPLOAD_TIMEOUT_MS);
      const response = await fetch(url, {
        method: "PUT", body: file, credentials: "same-origin",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": file.type || "application/octet-stream" },
        signal: AbortSignal.any([signal, timeout]),
      });
      if (response.status === 409) throw new SelectedUploadError("file_exists");
      if (!response.ok) throw new SelectedUploadError("unavailable");
    },
  }));
  const rows = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => () => controller.clear(), [controller]);

  return <div className="ph-no-capture border-b px-3 py-2 text-xs">
    <label className="inline-flex cursor-pointer items-center rounded border px-3 py-1.5 hover:bg-accent">
      Upload files
      <input type="file" multiple aria-label="Choose files to upload" className="sr-only" onChange={event => {
        controller.enqueue(Array.from(event.target.files ?? []), currentPath);
        event.target.value = "";
      }} />
    </label>
    <span className="ml-3 text-muted-foreground">Selected files and photos · up to 10 MB each</span>
    {rows.length > 0 ? <ul className="mt-2 space-y-1" aria-live="polite">
      {rows.map(row => <li key={row.id} className="flex flex-wrap items-center gap-2">
        <span>{row.name}</span>
        <span className="text-muted-foreground">{row.status === "uploading" ? "Uploading…" : row.status === "queued" ? "Waiting…" : row.error}</span>
        {row.status === "uploading" || row.status === "queued"
          ? <button type="button" aria-label={`Cancel ${row.name}`} onClick={() => controller.cancel(row.id)} className="underline">Cancel</button>
          : <button type="button" aria-label={`Retry ${row.name}`} onClick={() => controller.retry(row.id)} className="underline">Retry</button>}
        <button type="button" aria-label={`Remove ${row.name}`} onClick={() => controller.remove(row.id)} className="underline">Remove</button>
      </li>)}
    </ul> : null}
  </div>;
}
