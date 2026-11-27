/** Path helpers for home-relative document paths (forward slashes). */

export const DOCX_EXTENSION = ".docx";

/** The last segment of a path. */
export function fileName(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? path : path.slice(at + 1);
}

/** The directory of a path, without a trailing slash; `""` for the home root. */
export function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

function splitExtension(name: string): [string, string] {
  const at = name.lastIndexOf(".");
  return at <= 0 ? [name, ""] : [name.slice(0, at), name.slice(at)];
}

/**
 * The path of the nth copy beside a file: `plan.docx` gives `plan (copy).docx`,
 * then `plan (copy 2).docx`. A name that is already a copy is not nested.
 */
export function copyPath(path: string, attempt = 1): string {
  const directory = directoryOf(path);
  const [stem, extension] = splitExtension(fileName(path));
  const base = stem.replace(/ \(copy(?: \d+)?\)$/, "");
  const suffix = attempt <= 1 ? " (copy)" : ` (copy ${attempt})`;
  const name = `${base}${suffix}${extension === "" ? DOCX_EXTENSION : extension}`;
  return directory === "" ? name : `${directory}/${name}`;
}

/**
 * True for a path the files bridge accepts: 1 to 4096 characters, forward
 * slashes, no NUL or backslash, no leading or trailing slash and no empty,
 * `.` or `..` segment. Syntax only; access is decided by the gateway.
 */
export function isBridgePath(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) return false;
  if (path.includes("\u0000") || path.includes("\\")) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const MAX_NAME_LENGTH = 255;

/** A plain file name for a file from the computer: no folders or control characters, at most 255 characters. */
export function localFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_NAME_LENGTH);
  return clean === "" || clean === "." || clean === ".." ? `Document${DOCX_EXTENSION}` : clean;
}

/** The name a download gets: the document name, with `.docx` added when it has another or no extension. */
export function downloadName(name: string): string {
  const plain = localFileName(name);
  return plain.toLowerCase().endsWith(DOCX_EXTENSION) ? plain : `${plain}${DOCX_EXTENSION}`;
}
