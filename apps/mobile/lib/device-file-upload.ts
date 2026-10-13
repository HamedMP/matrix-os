import { File, UploadType } from "expo-file-system";

export interface DeviceFileUpload {
  /** Where the file is on the phone. */
  uri: string;
  url: string;
  headers: Record<string, string>;
  /** Ends the upload when it fires. */
  signal: AbortSignal;
}

export interface DeviceFileUploadResult {
  status: number;
  body: string;
}

/**
 * Sends a file on the phone as the whole body of a PUT. The system reads and
 * sends it, so its bytes never pass through JavaScript.
 */
export async function putDeviceFile({ uri, url, headers, signal }: DeviceFileUpload): Promise<DeviceFileUploadResult> {
  const result = await new File(uri).upload(url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    // Tied to the app being open, like the message it belongs to.
    sessionType: "foreground",
    headers,
    signal,
  });
  return { status: result.status, body: result.body };
}
