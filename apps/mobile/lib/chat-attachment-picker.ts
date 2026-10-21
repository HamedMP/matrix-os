import { getRandomValues } from "expo-crypto";
import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";

import {
  MAX_ATTACHMENT_BYTES,
  attachmentIdFrom,
  attachmentKindForMimeType,
  attachmentName,
  type AttachmentRejection,
  type ChatAttachmentKind,
  type ComposerAttachment,
} from "@/lib/chat-attachments";

/** The longest side a photo is sent with. A larger photo is scaled down to it. */
export const MAX_PHOTO_EDGE = 2_048;
const PHOTO_QUALITY = 0.8;
/** Preserve photo preparation independently of the larger ordinary-file transport. */
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
// The image types sent as they are. Any other, such as the HEIC an iPhone
// camera saves, is converted to JPEG, which every model that reads photos reads.
const SENDABLE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const SAFE_MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9.+/-]{1,119}$/;
const UNKNOWN_FILE_TYPE = "application/octet-stream";

export interface PickedAttachments {
  attachments: ComposerAttachment[];
  /** One entry for each thing that was chosen but is not attached. */
  rejections: AttachmentRejection[];
}

type Prepared = ComposerAttachment | AttachmentRejection;

function attachment(uri: string, name: string, mimeType: string, sizeBytes: number): Prepared {
  // Nothing is as good as unreadable: there would be nothing to send.
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "unreadable";
  if (sizeBytes > (attachmentKindForMimeType(mimeType) === "image" ? MAX_PHOTO_BYTES : MAX_ATTACHMENT_BYTES)) return "too_large";
  // From the system's own random source: the id is part of where the upload is kept.
  const id = attachmentIdFrom(getRandomValues(new Uint8Array(16)));
  return {
    id,
    uri,
    name: attachmentName(name, mimeType),
    mimeType,
    kind: attachmentKindForMimeType(mimeType),
    sizeBytes,
  };
}

function collect(prepared: Prepared[], leftOut: number): PickedAttachments {
  const picked: PickedAttachments = { attachments: [], rejections: [] };
  for (const item of prepared) {
    if (typeof item === "string") picked.rejections.push(item);
    else picked.attachments.push(item);
  }
  if (leftOut > 0) picked.rejections.push("over_limit");
  return picked;
}

function jpegName(name: string): string {
  return `${name.replace(/\.[A-Za-z0-9]{1,8}$/, "")}.jpg`;
}

/** Scales the photo down to the longest side allowed and saves it as a JPEG. */
async function scaledJpeg(asset: ImagePicker.ImagePickerAsset): Promise<{ uri: string; sizeBytes: number }> {
  const context = ImageManipulator.manipulate(asset.uri);
  try {
    if (Math.max(asset.width, asset.height) > MAX_PHOTO_EDGE) {
      context.resize(asset.width >= asset.height ? { width: MAX_PHOTO_EDGE } : { height: MAX_PHOTO_EDGE });
    }
    const image = await context.renderAsync();
    try {
      const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: PHOTO_QUALITY });
      return { uri: saved.uri, sizeBytes: new File(saved.uri).size };
    } finally {
      image.release();
    }
  } finally {
    context.release();
  }
}

async function preparePhoto(asset: ImagePicker.ImagePickerAsset, index: number): Promise<Prepared> {
  try {
    const mimeType = (asset.mimeType ?? "").toLowerCase();
    const name = asset.fileName?.trim() || `photo-${index + 1}.jpg`;
    const sizeBytes = asset.fileSize ?? new File(asset.uri).size;
    const sendable = SENDABLE_IMAGE_TYPES.includes(mimeType);
    if (sendable && Math.max(asset.width, asset.height) <= MAX_PHOTO_EDGE && sizeBytes <= MAX_PHOTO_BYTES) {
      return attachment(asset.uri, name, mimeType, sizeBytes);
    }
    // Scaling an animation down would leave a still of its first frame.
    if (mimeType === "image/gif") return "too_large";
    const converted = await scaledJpeg(asset);
    return attachment(converted.uri, jpegName(name), "image/jpeg", converted.sizeBytes);
  } catch (error: unknown) {
    console.warn("[chat] photo could not be prepared", error instanceof Error ? error.name : "unknown");
    return "unreadable";
  }
}

/**
 * Opens the photo library for up to `limit` photos. Resolves to null when the
 * person backs out without choosing, and rejects when the library cannot be opened.
 */
export async function pickPhotos(limit: number): Promise<PickedAttachments | null> {
  if (limit <= 0) return { attachments: [], rejections: ["over_limit"] };
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: true,
    selectionLimit: limit,
    orderedSelection: true,
    exif: false,
    quality: 1,
  });
  if (result.canceled) return null;
  const chosen = result.assets;
  const prepared: Prepared[] = [];
  for (const [index, asset] of chosen.slice(0, limit).entries()) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- intentional: a photo being scaled is held whole in memory, so they are prepared one at a time.
    prepared.push(await preparePhoto(asset, index));
  }
  return collect(prepared, chosen.length - limit);
}

function prepareFile(file: File, kinds: readonly ChatAttachmentKind[]): Prepared {
  try {
    const mimeType = SAFE_MIME_TYPE.test(file.type) ? file.type.toLowerCase() : UNKNOWN_FILE_TYPE;
    if (!kinds.includes(attachmentKindForMimeType(mimeType))) return "unsupported";
    return attachment(file.uri, file.name.trim() || "file", mimeType, file.size);
  } catch (error: unknown) {
    console.warn("[chat] file could not be read", error instanceof Error ? error.name : "unknown");
    return "unreadable";
  }
}

/**
 * Opens the system's file browser for up to `limit` files of the kinds the
 * model reads. Resolves to null when the person backs out without choosing,
 * and rejects when the browser cannot be opened.
 */
export async function pickFiles(limit: number, kinds: readonly ChatAttachmentKind[]): Promise<PickedAttachments | null> {
  if (limit <= 0) return { attachments: [], rejections: ["over_limit"] };
  const result = await File.pickFileAsync({ multipleFiles: true });
  if (result.canceled) return null;
  const chosen = result.result;
  return collect(chosen.slice(0, limit).map((file) => prepareFile(file, kinds)), chosen.length - limit);
}
