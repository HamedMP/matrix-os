import {
  CanonicalChatUserInputPartSchema,
  type CanonicalChatMessagePart,
  type CanonicalChatModelSelection,
  type CanonicalProviderCatalog,
} from "@matrix-os/contracts";

export type ChatAttachmentKind = "image" | "file";

/** A photo or file chosen for a message that has not been sent yet. It is still on the phone. */
export interface ComposerAttachment {
  /** Names it in the composer, and is part of where its upload is kept. */
  id: string;
  /** Where it is on the phone. */
  uri: string;
  /** The name shown for it and sent with it. */
  name: string;
  mimeType: string;
  kind: ChatAttachmentKind;
  sizeBytes: number;
}

/** An attachment as a message in the transcript shows it. */
export interface TranscriptAttachment {
  id: string;
  label: string;
  kind: ChatAttachmentKind;
  /** Where it is in the computer's home folder, when the message says. */
  path?: string;
  /** Where it still is on this phone, for a message sent from here. */
  localUri?: string;
}

export type ChatAttachmentReference = Extract<CanonicalChatMessagePart, { type: "attachment_reference" }>;

/** Why something that was chosen is not attached. */
export type AttachmentRejection = "too_large" | "unsupported" | "over_limit" | "unreadable";

/** The most one message carries, which is also the most the computer accepts. */
export const MAX_MESSAGE_ATTACHMENTS = 8;
/** The largest attachment sent: the limit the web composer applies. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// The computer clears this folder of old uploads by itself, and removes a
// single upload from nowhere else.
const UPLOAD_DIRECTORY = "temporary/desktop-chat";
const MAX_NAME_LENGTH = 120;
const ATTACHMENT_ID = /^att_[a-f0-9]{32}$/;
const NAME_ENDING = /\.[A-Za-z0-9]{1,8}$/;
// The picture types the app shows, each with the endings a name of that type
// has. The first is the one given to a name that has none of them.
const PICTURE_ENDINGS: Readonly<Record<string, readonly string[]>> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
};
const NO_KINDS: readonly ChatAttachmentKind[] = [];
const NO_UNREADABLE: readonly ComposerAttachment[] = [];

export function attachmentKindForMimeType(mimeType: string): ChatAttachmentKind {
  return mimeType.toLowerCase().startsWith("image/") ? "image" : "file";
}

/**
 * The id of a newly chosen attachment, from 16 random bytes. No two are alike
 * and none can be guessed, so no upload lands in another's place.
 */
export function attachmentIdFrom(bytes: Uint8Array): string {
  return `att_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function extensionOf(name: string): string {
  const match = NAME_ENDING.exec(name);
  return match ? match[0] : "";
}

/**
 * The name an attachment is sent under. A picture's name ends like its type:
 * the computer and the app tell a picture by the ending of its name, so one
 * named without it, as some photo libraries name theirs, would be shown as a
 * file as soon as the phone's copy is gone.
 */
export function attachmentName(name: string, mimeType: string): string {
  const endings = PICTURE_ENDINGS[mimeType.toLowerCase()];
  if (!endings || endings.includes(extensionOf(name).toLowerCase())) return name;
  return `${name}${endings[0]}`;
}

function attachmentLabel(name: string): string {
  const label = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (label.length <= MAX_NAME_LENGTH) return label;
  // A name too long is cut before its ending, which says what the file is.
  const ending = extensionOf(label);
  return `${label.slice(0, MAX_NAME_LENGTH - ending.length)}${ending}`;
}

/**
 * Where the attachment's upload is kept in the computer's home folder. It is
 * the same every time for one attachment, so sending again writes over the
 * first upload instead of leaving a second.
 */
export function chatAttachmentUploadPath(attachment: Pick<ComposerAttachment, "id" | "name">): string | null {
  if (!ATTACHMENT_ID.test(attachment.id)) return null;
  const fileName = attachmentLabel(attachment.name)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+$/, "");
  return `${UPLOAD_DIRECTORY}/${attachment.id}-${fileName || "attachment"}`;
}

/**
 * The part of a message that names an uploaded attachment, or null when the
 * attachment cannot be described to the computer. A file name the computer
 * would refuse as a label is replaced by a plain one with the same ending.
 */
export function chatAttachmentPart(attachment: ComposerAttachment): ChatAttachmentReference | null {
  const ownerReference = chatAttachmentUploadPath(attachment);
  if (!ownerReference) return null;
  const label = attachmentLabel(attachment.name);
  const plainLabel = `${attachment.kind === "image" ? "Photo" : "File"}${extensionOf(label)}`;
  for (const candidate of [label, plainLabel]) {
    const part = CanonicalChatUserInputPartSchema.safeParse({
      type: "attachment_reference",
      attachmentId: `mobile_upload_${attachment.id}`,
      kind: attachment.kind,
      label: candidate,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      ownerReference,
    });
    if (part.success && part.data.type === "attachment_reference") return part.data;
  }
  return null;
}

/** The kinds of attachment the selected model reads. None while the model is not known. */
export function supportedAttachmentKinds(
  catalog: CanonicalProviderCatalog | null,
  selection: CanonicalChatModelSelection | null,
): readonly ChatAttachmentKind[] {
  if (!catalog || !selection) return NO_KINDS;
  const instance = catalog.instances.find((candidate) => candidate.id === selection.instanceId);
  if (instance?.availability !== "available") return NO_KINDS;
  const kinds: ChatAttachmentKind[] = [];
  if (instance.supports.attachments.includes("image")) kinds.push("image");
  if (instance.supports.attachments.includes("file")) kinds.push("file");
  return kinds.length > 0 ? kinds : NO_KINDS;
}

/** The same attachments in the same order. */
export function sameAttachments(left: readonly ComposerAttachment[], right: readonly ComposerAttachment[]): boolean {
  return left.length === right.length && left.every((attachment, index) => attachment.id === right[index]?.id);
}

/**
 * `added` after `current`, each attachment once, up to `limit` in all. What is
 * already in `current` always stays; of `added`, the first that fit.
 */
export function appendAttachments(
  current: readonly ComposerAttachment[],
  added: readonly ComposerAttachment[],
  limit: number = MAX_MESSAGE_ATTACHMENTS,
): ComposerAttachment[] {
  const merged = [...current];
  for (const attachment of added) {
    if (merged.length >= limit) break;
    if (!merged.some((existing) => existing.id === attachment.id)) merged.push(attachment);
  }
  return merged;
}

/** The waiting attachments the selected model does not read, which a message cannot be sent with. */
export function unreadableAttachments(
  attachments: readonly ComposerAttachment[],
  kinds: readonly ChatAttachmentKind[],
): readonly ComposerAttachment[] {
  const readsPhotos = kinds.includes("image");
  const readsFiles = kinds.includes("file");
  const unreadable = attachments.filter((attachment) => !(attachment.kind === "image" ? readsPhotos : readsFiles));
  return unreadable.length > 0 ? unreadable : NO_UNREADABLE;
}

/** What to tell the person about waiting attachments the selected model does not read. Null when it reads them all. */
export function unreadableNotice(unreadable: readonly ComposerAttachment[]): string | null {
  if (unreadable.length === 0) return null;
  const photos = unreadable.every((attachment) => attachment.kind === "image");
  const files = unreadable.every((attachment) => attachment.kind === "file");
  const what = photos ? "photos" : files ? "files" : "these attachments";
  return `The selected model cannot read ${what}. Remove ${unreadable.length === 1 ? "it" : "them"} or choose another model.`;
}

/** A new chat's title when its first message is attachments and no text. */
export function attachmentsTitle(attachments: readonly ComposerAttachment[]): string {
  const photos = attachments.every((attachment) => attachment.kind === "image");
  if (attachments.length === 1) return photos ? "Photo" : "File";
  return `${attachments.length} ${photos ? "photos" : "files"}`;
}

const MAX_ATTACHMENT_SIZE_TEXT = `${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`;

const REJECTION_TEXT: Record<AttachmentRejection, (count: number) => string> = {
  too_large: (count) => (
    count === 1
      ? `1 item is larger than ${MAX_ATTACHMENT_SIZE_TEXT}.`
      : `${count} items are larger than ${MAX_ATTACHMENT_SIZE_TEXT}.`
  ),
  unsupported: (count) => (
    count === 1 ? "This model cannot read 1 of the items." : `This model cannot read ${count} of the items.`
  ),
  over_limit: () => `A message carries up to ${MAX_MESSAGE_ATTACHMENTS} attachments.`,
  unreadable: (count) => (count === 1 ? "1 item could not be read." : `${count} items could not be read.`),
};

/** What to tell the person about the things they chose that were not attached. Null when all were. */
export function rejectionNotice(rejections: readonly AttachmentRejection[]): string | null {
  if (rejections.length === 0) return null;
  const reasons: AttachmentRejection[] = ["too_large", "unsupported", "unreadable", "over_limit"];
  return reasons
    .map((reason) => {
      const count = rejections.filter((rejection) => rejection === reason).length;
      return count > 0 ? REJECTION_TEXT[reason](count) : null;
    })
    .filter(Boolean)
    .join(" ");
}

/**
 * Attachments waiting in composers, one list per chat plus one for the new
 * chat being composed. Kept apart like the text drafts, and bounded the same
 * way: past the cap, the list written longest ago is dropped.
 */
export type ChatAttachmentDrafts = Readonly<Record<string, readonly ComposerAttachment[]>>;

export const MAX_ATTACHMENT_DRAFTS = 20;

const NO_ATTACHMENTS: readonly ComposerAttachment[] = [];

export function readAttachmentDraft(drafts: ChatAttachmentDrafts, key: string): readonly ComposerAttachment[] {
  return drafts[key] ?? NO_ATTACHMENTS;
}

/** Sets a chat's waiting attachments, or forgets the chat when there are none. */
export function writeAttachmentDraft(
  drafts: ChatAttachmentDrafts,
  key: string,
  attachments: readonly ComposerAttachment[],
): ChatAttachmentDrafts {
  if (attachments.length === 0 && !(key in drafts)) return drafts;
  const others = Object.entries(drafts).filter(([existing]) => existing !== key);
  if (attachments.length === 0) return Object.fromEntries(others);
  return Object.fromEntries([...others, [key, attachments] as const].slice(-MAX_ATTACHMENT_DRAFTS));
}

/** Carries waiting attachments over when their chat changes identity, after any the chat already has. */
export function moveAttachmentDraft(drafts: ChatAttachmentDrafts, from: string, to: string): ChatAttachmentDrafts {
  const moving = drafts[from];
  if (!moving || moving.length === 0) return drafts;
  const merged = appendAttachments(readAttachmentDraft(drafts, to), moving);
  return writeAttachmentDraft(writeAttachmentDraft(drafts, from, NO_ATTACHMENTS), to, merged);
}

/**
 * Where sent attachments still are on this phone, by their place on the
 * computer, so a sent photo keeps showing from the phone once the computer's
 * copy of the message takes over. Bounded: the oldest entries go first.
 */
export type SentAttachmentUris = Readonly<Record<string, string>>;

export const MAX_SENT_ATTACHMENT_URIS = 32;

export function rememberSentAttachments(
  sent: SentAttachmentUris,
  attachments: readonly ComposerAttachment[],
): SentAttachmentUris {
  const added = attachments.flatMap((attachment) => {
    const path = chatAttachmentUploadPath(attachment);
    return path ? [[path, attachment.uri] as const] : [];
  });
  if (added.length === 0) return sent;
  const others = Object.entries(sent).filter(([path]) => !added.some(([addedPath]) => addedPath === path));
  return Object.fromEntries([...others, ...added].slice(-MAX_SENT_ATTACHMENT_URIS));
}
