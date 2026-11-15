/**
 * How the phone lays out a tool request's details. The computer sends the tool
 * input as JSON after the card's summary (`supervisedToolApproval().details`);
 * this turns it into named lines so nobody has to read JSON on a phone.
 */

export interface ApprovalDetailField {
  /** The input's own name, unique within one request. */
  key: string;
  label: string;
  value: string;
  /** Drawn in the code font: commands, paths, addresses, patterns. */
  code: boolean;
}

const MAX_FIELDS = 24;

// Inputs of Claude's built-in tools. Anything else is named from its key.
const NAMED: Record<string, { label: string; code: boolean }> = {
  command: { label: "Command", code: true },
  description: { label: "Description", code: false },
  file_path: { label: "File", code: true },
  notebook_path: { label: "Notebook", code: true },
  path: { label: "Path", code: true },
  url: { label: "Address", code: true },
  query: { label: "Search", code: false },
  pattern: { label: "Pattern", code: true },
  prompt: { label: "Prompt", code: false },
  content: { label: "Content", code: true },
  old_string: { label: "Text to replace", code: true },
  new_string: { label: "New text", code: true },
};

/** "run_in_background" and "dangerouslyDisableSandbox" as words. */
function labelFromKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

function fieldFor(key: string, value: unknown): ApprovalDetailField | null {
  if (value === undefined) return null;
  const named = NAMED[key];
  const label = named?.label ?? labelFromKey(key);
  // Shown, not dropped: an empty replacement deletes the text it replaces.
  if (value === "") return { key, label, value: "Empty", code: false };
  if (value === null) return { key, label, value: "None", code: false };
  if (typeof value === "string") return { key, label, value, code: named?.code ?? true };
  if (typeof value === "boolean") return { key, label, value: value ? "Yes" : "No", code: false };
  if (typeof value === "number") return { key, label, value: String(value), code: false };
  return { key, label, value: JSON.stringify(value, null, 2), code: true };
}

/**
 * The request's details as named lines, or null when they are not a JSON object
 * (cut short by the computer, or plain text) and are shown as they came.
 */
export function approvalDetailFields(details: string): ApprovalDetailField[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(details);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const fields = Object.entries(parsed)
    .map(([key, value]) => fieldFor(key, value))
    .filter((field): field is ApprovalDetailField => field !== null)
    .slice(0, MAX_FIELDS);
  return fields.length > 0 ? fields : null;
}

/**
 * "Run a command · “echo hello”" as the action and what it acts on, so the
 * card can set the command apart. Titles without a subject stay whole.
 */
export function approvalTitleParts(title: string): { action: string; subject?: string } {
  const match = /^(.+?) · “([\s\S]+)”$/u.exec(title);
  return match ? { action: match[1]!, subject: match[2]! } : { action: title };
}
