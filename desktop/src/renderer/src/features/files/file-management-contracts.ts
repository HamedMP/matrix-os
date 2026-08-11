import { z } from "zod/v4";

const utf8 = new TextEncoder();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const INVALID_PORTABLE_NAME_CHARACTER = /[\\/:*?"<>|]/;
const RESERVED_PLATFORM_NAME = /^(con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const OwnerRelativePathSchema = z.string().min(1).max(4_096).refine((value) =>
  utf8.encode(value).byteLength <= 4_096
  && !value.startsWith("/")
  && !value.includes("\\")
  && !/^[a-zA-Z]:\//.test(value)
  && !CONTROL_CHARACTER.test(value)
  && value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
);

export const OwnerDirectoryPathSchema = z.union([z.literal(""), OwnerRelativePathSchema]);

export const FileEntryNameSchema = z.string().min(1).max(255).refine((value) =>
  utf8.encode(value).byteLength <= 255
  && value !== "."
  && value !== ".."
  && !value.includes("/")
  && !value.includes("\\")
  && !CONTROL_CHARACTER.test(value),
);

export const FileMutationNameSchema = FileEntryNameSchema.refine((value) =>
  value.trim().length > 0
  && !INVALID_PORTABLE_NAME_CHARACTER.test(value)
  && !/[ .]$/.test(value)
  && !RESERVED_PLATFORM_NAME.test(value),
);

export const RendererFileEntryCapabilitiesSchema = z.object({
  canRename: z.boolean(),
  canMove: z.boolean(),
  canTrash: z.boolean(),
  readOnlyReason: z.enum(["protected", "policy"]).optional(),
}).strict();

export type RendererFileEntryCapabilities = z.infer<typeof RendererFileEntryCapabilitiesSchema>;
