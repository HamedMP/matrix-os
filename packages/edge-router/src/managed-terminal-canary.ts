const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const CONFIG_KEYS = ["sourceHandle", "chatId", "candidateOrigin", "expiresAt"];
const PRIMARY_CHAT_MUTATION = /^\/vm\/([a-z0-9][a-z0-9-]{1,62})(\/~runtime\/primary)?\/api\/chats\/(chat_[A-Za-z0-9_-]{1,128})\/(?:turns|runs\/run_[A-Za-z0-9_-]{1,128}\/cancel)$/;
export const MANAGED_TERMINAL_CANARY_MARKER = "x-matrix-terminal-canary-route";

function readConfig(raw: string) {
  if (raw.length > 1024) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const config = decoded as Record<string, unknown>;
  return Object.keys(config).length === CONFIG_KEYS.length && CONFIG_KEYS.every(key => Object.hasOwn(config, key))
    ? config
    : null;
}

/** Routing only. The candidate Platform verifies the browser, owner, and machine identity. */
export function managedTerminalCanaryOrigin(
  request: Request,
  url: URL,
  rawConfig: string | undefined,
  platformOrigin: string,
): string | null {
  if (!rawConfig || request.method !== "POST" || url.origin !== "https://app.matrix-os.com"
    || request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const match = PRIMARY_CHAT_MUTATION.exec(url.pathname);
  if (!match || /^(?:pr|pv)-/.test(match[1]!)) return null;
  const [, sourceHandle, explicitPrimary, chatId] = match;
  const slots = url.searchParams.getAll("runtime");
  if (url.searchParams.has("token") || slots.length > 1
    || (slots.length === 0 ? !explicitPrimary : slots[0] !== "primary")) return null;

  const config = readConfig(rawConfig);
  if (!config || config.sourceHandle !== sourceHandle || config.chatId !== chatId
    || typeof config.expiresAt !== "number" || !Number.isSafeInteger(config.expiresAt)
    || typeof config.candidateOrigin !== "string") return null;
  const remainingMs = config.expiresAt - Date.now();
  if (remainingMs <= 0 || remainingMs > MAX_DURATION_MS) return null;

  const baseHost = new URL(platformOrigin).hostname;
  let tagged: URL;
  try {
    tagged = new URL(config.candidateOrigin);
  } catch (error: unknown) {
    if (error instanceof TypeError) return null;
    throw error;
  }
  const suffix = `---${baseHost}`;
  if (tagged.protocol !== "https:" || config.candidateOrigin !== tagged.origin
    || !baseHost.endsWith(".run.app") || !tagged.hostname.endsWith(suffix)) return null;
  const tag = tagged.hostname.slice(0, -suffix.length);
  return /^tc-[a-f0-9]{7,12}$/.test(tag) ? tagged.origin : null;
}
