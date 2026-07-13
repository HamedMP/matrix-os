const BRACKETED_PASTE_OPEN = "\x1b[200~";
const BRACKETED_PASTE_CLOSE = "\x1b[201~";
const BRACKETED_PASTE_OVERHEAD = BRACKETED_PASTE_OPEN.length + BRACKETED_PASTE_CLOSE.length;
const MAX_TERMINAL_INPUT = 65_536;
const TERMINAL_PASTE_IMAGE_DIR = "data/terminal-paste";
const TERMINAL_PASTE_UPLOAD_TIMEOUT_MS = 30_000;
const MATRIX_HOME_ABSOLUTE_PATH = "/home/matrix/home";

type TerminalInputSink = {
  readyState: number;
  send(data: string): void;
};

type ClipboardLike = {
  read?: () => Promise<ClipboardItems>;
  readText?: () => Promise<string>;
};

type ClipboardItems = Array<{
  types: readonly string[];
  getType(type: string): Promise<Blob>;
}>;

type ClipboardDataLike = {
  items?: ArrayLike<{
    kind?: string;
    type: string;
    getAsFile?: () => Blob | null;
  }>;
  files?: ArrayLike<Blob>;
};

type ClipboardImageBlob = {
  blob: Blob;
  type: string;
};

export function bracketTerminalPaste(text: string): string {
  const safe = text.replace(/\x1b\[20[01]~/g, "");
  const capped = safe.slice(0, MAX_TERMINAL_INPUT - BRACKETED_PASTE_OVERHEAD);
  return `${BRACKETED_PASTE_OPEN}${capped}${BRACKETED_PASTE_CLOSE}`;
}

export function sendBracketedTerminalPaste(ws: TerminalInputSink | null | undefined, text: string): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }
  ws.send(JSON.stringify({ type: "input", data: bracketTerminalPaste(text) }));
  return true;
}

function sendFormattedTerminalPaste(input: {
  ws: TerminalInputSink | null | undefined;
  text: string;
  submit?: boolean;
}): boolean {
  if (!sendBracketedTerminalPaste(input.ws, input.text)) {
    return false;
  }
  if (input.submit === true) {
    input.ws?.send(JSON.stringify({ type: "input", data: "\r" }));
  }
  return true;
}

function normalizeMatrixPath(path: string): string {
  return path.replace(/^~\//, "").replace(/^\/home\/matrix\/home\//, "").replace(/^\/+/, "");
}

export function formatTerminalPastePrompt(paths: string[], message?: string): string {
  const normalizedPaths = paths.map(normalizeMatrixPath).filter((path) => path.length > 0);
  if (normalizedPaths.length === 0) {
    return message?.trim() || "";
  }
  const prefix = message?.trim() ? `${message.trim()}\n\n` : "";
  if (normalizedPaths.length === 1) {
    const path = normalizedPaths[0]!;
    return `${prefix}Screenshot attached at ${MATRIX_HOME_ABSOLUTE_PATH}/${path} (also ~/${path}). Please inspect it.`;
  }
  const lines = normalizedPaths.map((path) => `- ${MATRIX_HOME_ABSOLUTE_PATH}/${path} (also ~/${path})`);
  return `${prefix}Screenshots attached:\n${lines.join("\n")}\nPlease inspect them.`;
}

function extensionForMime(type: string): string | null {
  switch (type.toLowerCase()) {
    case "image/png":
      return "png";
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return null;
  }
}

export function terminalPasteImagePath(type: string, now = new Date()): string | null {
  const extension = extensionForMime(type);
  if (!extension) {
    return null;
  }
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  return `${TERMINAL_PASTE_IMAGE_DIR}/paste-${stamp}-${random}.${extension}`;
}

async function uploadClipboardImage(gatewayUrl: string, blob: Blob, remotePath: string): Promise<void> {
  const url = new URL("/api/files/blob", gatewayUrl);
  url.searchParams.set("path", remotePath);
  const res = await fetch(url.toString(), {
    method: "PUT",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
    signal: AbortSignal.timeout(TERMINAL_PASTE_UPLOAD_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`image upload failed (${res.status})`);
  }
}

async function uploadImageBlob(input: {
  gatewayUrl: string;
  blob: Blob;
  type: string;
}): Promise<string | null> {
  const remotePath = terminalPasteImagePath(input.type);
  if (!remotePath) {
    return null;
  }
  await uploadClipboardImage(input.gatewayUrl, input.blob, remotePath);
  return `~/${remotePath}`;
}

export function clipboardDataHasImage(data: ClipboardDataLike | null | undefined): boolean {
  if (!data) {
    return false;
  }
  const items = Array.from(data.items ?? []);
  if (items.some((item) => extensionForMime(item.type))) {
    return true;
  }
  return Array.from(data.files ?? []).some((file) => extensionForMime(file.type));
}

export async function readClipboardDataImagePaths(input: {
  clipboardData: ClipboardDataLike | null | undefined;
  gatewayUrl: string;
}): Promise<string[]> {
  const data = input.clipboardData;
  if (!data) {
    return [];
  }

  const images: ClipboardImageBlob[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (!extensionForMime(item.type)) {
      continue;
    }
    const blob = item.getAsFile?.();
    if (!blob) {
      continue;
    }
    images.push({ blob, type: item.type || blob.type });
  }

  if (images.length === 0) {
    for (const file of Array.from(data.files ?? [])) {
      images.push({ blob: file, type: file.type });
    }
  }

  const paths: string[] = [];
  for (const image of images) {
    const path = await uploadImageBlob({ gatewayUrl: input.gatewayUrl, blob: image.blob, type: image.type });
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}

export async function readClipboardImagePaths(input: {
  clipboard: ClipboardLike | undefined;
  gatewayUrl: string;
}): Promise<string[]> {
  if (!input.clipboard?.read) {
    return [];
  }

  const items = await input.clipboard.read();
  const paths: string[] = [];
  for (const item of items) {
    const imageType = item.types.find((type) => extensionForMime(type));
    if (!imageType) {
      continue;
    }
    const blob = await item.getType(imageType);
    const path = await uploadImageBlob({ gatewayUrl: input.gatewayUrl, blob, type: imageType });
    if (path) {
      paths.push(path);
    }
  }
  return paths;
}


export async function pasteClipboardDataIntoTerminal(input: {
  clipboardData: ClipboardDataLike | null | undefined;
  gatewayUrl: string;
  ws: TerminalInputSink | null | undefined;
  submit?: boolean;
}): Promise<"image" | "empty"> {
  const imagePaths = await readClipboardDataImagePaths({
    clipboardData: input.clipboardData,
    gatewayUrl: input.gatewayUrl,
  });
  if (imagePaths.length === 0) {
    return "empty";
  }
  sendFormattedTerminalPaste({
    ws: input.ws,
    text: formatTerminalPastePrompt(imagePaths),
    submit: input.submit,
  });
  return "image";
}

export async function pasteClipboardIntoTerminal(input: {
  clipboard: ClipboardLike | undefined;
  gatewayUrl: string;
  ws: TerminalInputSink | null | undefined;
  submit?: boolean;
}): Promise<"image" | "text" | "empty" | "unavailable"> {
  if (!input.clipboard?.read && !input.clipboard?.readText) {
    return "unavailable";
  }

  if (input.clipboard.read) {
    try {
      const imagePaths = await readClipboardImagePaths({
        clipboard: input.clipboard,
        gatewayUrl: input.gatewayUrl,
      });
      if (imagePaths.length > 0) {
        sendFormattedTerminalPaste({
          ws: input.ws,
          text: formatTerminalPastePrompt(imagePaths),
          submit: input.submit,
        });
        return "image";
      }
    } catch (err: unknown) {
      console.warn("Clipboard image paste failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!input.clipboard.readText) {
    return "empty";
  }

  const text = await input.clipboard.readText();
  if (text.length === 0) {
    return "empty";
  }
  sendFormattedTerminalPaste({ ws: input.ws, text, submit: input.submit });
  return "text";
}
