import { z } from "zod/v4";

import {
  buildGatewayRequestUrl,
  fetchAuthenticatedJson,
  fetchAuthenticatedResponse,
} from "@/lib/requests/http";

const FILES_UNAVAILABLE_ERROR = "Files unavailable. Try again.";
const MAX_FILE_NAME_LENGTH = 512;
const MAX_FILE_PATH_LENGTH = 4_096;
const MAX_FILE_ENTRIES = 5_000;
const DEFAULT_FILE_PREVIEW_BYTES = 512 * 1024;
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

const FileEntrySchema = z.object({
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  type: z.enum(["file", "directory"]),
  size: z.number().nonnegative().optional(),
  gitStatus: z.string().max(64).nullable(),
  changedCount: z.number().int().nonnegative().optional(),
  modified: z.string().max(64).optional(),
  created: z.string().max(64).optional(),
  mime: z.string().max(128).optional(),
  children: z.number().int().nonnegative().optional(),
});

const FileListResponseSchema = z.object({
  path: z.string().max(MAX_FILE_PATH_LENGTH),
  entries: z.array(FileEntrySchema).max(MAX_FILE_ENTRIES),
});

const FileStatResponseSchema = z.object({
  name: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  path: z.string().max(MAX_FILE_PATH_LENGTH),
  type: z.enum(["file", "directory"]),
  size: z.number().int().nonnegative().optional(),
  modified: z.string().max(64),
  created: z.string().max(64),
  mime: z.string().max(128).optional(),
});

export type FileEntry = z.infer<typeof FileEntrySchema>;
export type FileListResponse = z.infer<typeof FileListResponseSchema>;
export type FilePreview =
  | { kind: "image"; uri: string; authorization: string }
  | { kind: "text"; content: string }
  | {
      kind: "unpreviewable";
      reason: "too-large" | "binary" | "unknown-size";
      size?: number;
    };

export function fetchFileList(
  clerkToken: string,
  computerGatewayUrl: string,
  path: string,
): Promise<FileListResponse> {
  const safePath = normalizeFilePath(path);
  if (safePath === null) return Promise.reject(new Error(FILES_UNAVAILABLE_ERROR));

  let url: string;
  try {
    url = buildGatewayRequestUrl(computerGatewayUrl, "/api/files/list", { path: safePath });
  } catch {
    return Promise.reject(new Error(FILES_UNAVAILABLE_ERROR));
  }

  return fetchAuthenticatedJson({
    url,
    token: clerkToken,
    schema: FileListResponseSchema,
    errorMessage: FILES_UNAVAILABLE_ERROR,
  });
}

export async function fetchFilePreview(
  clerkToken: string,
  computerGatewayUrl: string,
  path: string,
  maxBytes = DEFAULT_FILE_PREVIEW_BYTES,
): Promise<FilePreview> {
  const safePath = normalizeFilePath(path);
  if (!clerkToken.trim() || !safePath || maxBytes <= 0) {
    throw new Error(FILES_UNAVAILABLE_ERROR);
  }

  let rawFileUri: string;
  try {
    const encodedPath = safePath.split("/").map(encodeURIComponent).join("/");
    rawFileUri = buildGatewayRequestUrl(computerGatewayUrl, `/files/${encodedPath}`);
  } catch {
    throw new Error(FILES_UNAVAILABLE_ERROR);
  }

  if (isImagePath(safePath)) {
    return {
      kind: "image",
      uri: rawFileUri,
      authorization: `Bearer ${clerkToken}`,
    };
  }

  let statUrl: string;
  let blobUrl: string;
  try {
    statUrl = buildGatewayRequestUrl(computerGatewayUrl, "/api/files/stat", { path: safePath });
    blobUrl = buildGatewayRequestUrl(computerGatewayUrl, "/api/files/blob", { path: safePath });
  } catch {
    throw new Error(FILES_UNAVAILABLE_ERROR);
  }

  const fileStat = await fetchAuthenticatedJson({
    url: statUrl,
    token: clerkToken,
    schema: FileStatResponseSchema,
    errorMessage: FILES_UNAVAILABLE_ERROR,
  });
  if (fileStat.type !== "file" || fileStat.size === undefined) {
    return { kind: "unpreviewable", reason: "unknown-size" };
  }
  if (fileStat.size > maxBytes) {
    return { kind: "unpreviewable", reason: "too-large", size: fileStat.size };
  }

  return fetchAuthenticatedResponse<FilePreview>(
    {
      url: blobUrl,
      token: clerkToken,
      errorMessage: FILES_UNAVAILABLE_ERROR,
    },
    async (response) => {
      const content = await response.text();
      const receivedBytes = new TextEncoder().encode(content).byteLength;
      if (receivedBytes > maxBytes) {
        return { kind: "unpreviewable", reason: "too-large", size: receivedBytes };
      }
      if (looksBinary(content)) {
        return { kind: "unpreviewable", reason: "binary", size: receivedBytes };
      }
      return { kind: "text", content };
    },
  );
}

function normalizeFilePath(path: string): string | null {
  if (path.length > MAX_FILE_PATH_LENGTH || path.includes("\0")) return null;
  const segments = path.split("/").filter((segment) => segment && segment !== ".");
  if (segments.some((segment) => segment === "..")) return null;
  return segments.join("/");
}

function isImagePath(path: string): boolean {
  const name = path.split("/").at(-1) ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLowerCase() : "";
  return extension ? IMAGE_EXTENSIONS.has(extension) : false;
}

function looksBinary(content: string): boolean {
  const sample = content.slice(0, 4_096);
  if (!sample) return false;
  let controlCharacters = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) controlCharacters += 1;
  }
  return controlCharacters / sample.length > 0.1;
}
