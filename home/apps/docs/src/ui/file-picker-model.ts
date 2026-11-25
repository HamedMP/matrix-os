/** Pure helpers of the Open and Save dialogs. */

import { DOCX_EXTENSION, isBridgePath } from "../session/index";

export function isDocxPath(path: string): boolean {
  return isBridgePath(path) && path.toLowerCase().endsWith(DOCX_EXTENSION);
}

/** The path for a folder and a name, with `.docx` added when missing; null when it cannot be used. */
export function savePath(folder: string, name: string): string | null {
  const cleanFolder = folder.trim().replace(/^\/+|\/+$/g, "");
  let cleanName = name.trim();
  if (cleanName === "") return null;
  if (!cleanName.toLowerCase().endsWith(DOCX_EXTENSION)) cleanName += DOCX_EXTENSION;
  const path = cleanFolder === "" ? cleanName : `${cleanFolder}/${cleanName}`;
  return isDocxPath(path) ? path : null;
}
