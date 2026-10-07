import type * as DocumentPicker from "expo-document-picker";
import type * as ImagePicker from "expo-image-picker";
import { File as DeviceFile, Paths } from "expo-file-system";
import { fetch as expoFetch } from "expo/fetch";
import {
  isSafeUploadDirectory,
  isSafeUploadName,
  MAX_SELECTED_UPLOAD_BYTES,
  MAX_SELECTED_UPLOAD_QUEUE,
  SELECTED_UPLOAD_TIMEOUT_MS,
  SelectedUploadError,
} from "@matrix-os/contracts/file-upload";
import { z } from "zod/v4";
import { buildGatewayRequestUrl, createRequestTimeout } from "./requests/http";

export type SelectedDeviceFile = {
  name: string;
  size: number;
  uri: string;
  type?: string;
  webFile?: File;
};

const UploadedFileSchema = z.object({
  ok: z.literal(true),
  path: z.string().min(1).max(4096),
  size: z.number().int().min(0).max(MAX_SELECTED_UPLOAD_BYTES),
});

function localBody(asset: SelectedDeviceFile): Blob {
  if (asset.webFile) return asset.webFile;
  // Never download arbitrary URLs or copy device originals for upload.
  if (!/^(file|content):\/\//u.test(asset.uri)) throw new SelectedUploadError("unavailable");
  return new DeviceFile(asset.uri);
}

export async function pickSelectedDeviceFiles(kind: "files" | "photos"): Promise<SelectedDeviceFile[]> {
  // Call this directly in a press handler: browsers require user activation.
  // Lazy, synchronous loading also lets older native clients display a safe
  // error instead of crashing Files when a picker module needs a client rebuild.
  const documentPicker = kind === "files" ? require("expo-document-picker") as typeof DocumentPicker : null;
  const imagePicker = kind === "photos" ? require("expo-image-picker") as typeof ImagePicker : null;
  const result = kind === "files"
    ? await documentPicker!.getDocumentAsync({ type: "*/*", multiple: true, copyToCacheDirectory: true, base64: false })
    : await imagePicker!.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: false,
      allowsMultipleSelection: true, selectionLimit: MAX_SELECTED_UPLOAD_QUEUE, quality: 1, exif: false, base64: false, legacy: false });
  if (result.canceled) return [];
  const selected: SelectedDeviceFile[] = [];
  try {
    for (const [index, asset] of result.assets.entries()) {
      const document = asset as DocumentPicker.DocumentPickerAsset;
      const photo = asset as ImagePicker.ImagePickerAsset;
      const file: SelectedDeviceFile = {
        uri: asset.uri,
        name: document.name ?? photo.fileName ?? `photo-${Date.now()}-${index}.jpg`,
        size: 0,
        type: asset.mimeType,
        webFile: asset.file,
      };
      const body = localBody(file);
      file.size = body.size;
      if (selected.length >= MAX_SELECTED_UPLOAD_QUEUE || !isSafeUploadName(file.name)
        || !Number.isSafeInteger(file.size) || file.size < 0) {
        cleanupSelectedDeviceFile(file);
        continue;
      }
      selected.push(file);
    }
    return selected;
  } catch (error: unknown) {
    for (const asset of result.assets) cleanupSelectedDeviceFile({ uri: asset.uri, name: "", size: 0 });
    console.warn("[selected-upload] device selection unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new SelectedUploadError("unavailable");
  }
}

export async function uploadSelectedDeviceFile(
  token: string,
  gatewayUrl: string,
  asset: SelectedDeviceFile,
  path: string,
  signal: AbortSignal,
): Promise<void> {
  if (!token.trim() || !isSafeUploadName(asset.name) || !path || !isSafeUploadDirectory(path)
    || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > MAX_SELECTED_UPLOAD_BYTES) {
    throw new SelectedUploadError("unavailable");
  }
  const timeout = createRequestTimeout(SELECTED_UPLOAD_TIMEOUT_MS);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  timeout.signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted || timeout.signal.aborted) abort();
  try {
    const body = localBody(asset);
    if (body.size !== asset.size || body.size > MAX_SELECTED_UPLOAD_BYTES) throw new SelectedUploadError("unavailable");
    const url = buildGatewayRequestUrl(gatewayUrl, "/api/files/blob", { path });
    const response = await expoFetch(url, { method: "PUT", body, signal: controller.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": asset.type ?? "application/octet-stream" } });
    if (response.status === 409) throw new SelectedUploadError("file_exists");
    if (!response.ok) throw new SelectedUploadError("unavailable");
    const uploaded = UploadedFileSchema.parse(await response.json());
    if (uploaded.path !== path || uploaded.size !== asset.size) throw new SelectedUploadError("unavailable");
  } catch (error: unknown) {
    if (error instanceof SelectedUploadError) throw error;
    console.warn("[selected-upload] upload unavailable", error instanceof Error ? error.name : "UnknownError");
    throw new SelectedUploadError("unavailable");
  } finally {
    timeout.cancel();
    signal.removeEventListener("abort", abort);
    timeout.signal.removeEventListener("abort", abort);
  }
}

/** Only delete temporary picker copies, never the original user document. */
export function cleanupSelectedDeviceFile(asset: SelectedDeviceFile): void {
  if (asset.webFile || !asset.uri.startsWith("file://")) return;
  try {
    const cached = new URL(Paths.cache.uri);
    const selected = new URL(asset.uri);
    if (!selected.pathname.startsWith(`${cached.pathname.replace(/\/+$/, "")}/`)) return;
    const file = new DeviceFile(selected.toString());
    if (file.exists) file.delete();
  } catch (error: unknown) {
    console.warn("[selected-upload] cache cleanup unavailable", error instanceof Error ? error.name : "UnknownError");
  }
}
