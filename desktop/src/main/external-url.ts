const MAX_EXTERNAL_URL_LENGTH = 2048;

interface ExternalHttpUrlOpenerOptions {
  disabled: boolean;
  openExternal: (url: string) => Promise<void>;
}

export function safeExternalHttpUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch (_err: unknown) {
    return null;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.toString().length > MAX_EXTERNAL_URL_LENGTH
  ) {
    return null;
  }
  return parsed.toString();
}

export function createExternalHttpUrlOpener({
  disabled,
  openExternal,
}: ExternalHttpUrlOpenerOptions): (url: string) => Promise<void> {
  return async (url) => {
    const externalUrl = safeExternalHttpUrl(url);
    if (!externalUrl || disabled) return;
    await openExternal(externalUrl);
  };
}
