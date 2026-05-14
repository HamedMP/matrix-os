export interface PreviewPolicyInput {
  url: string;
  allowedPorts: number[];
}

export interface PreviewRefInput extends PreviewPolicyInput {
  label: string;
}

export type PreviewPolicyResult =
  | { ok: true; url: string; port: number }
  | { ok: false; code: "invalid_url" | "disallowed_protocol" | "disallowed_host" | "disallowed_port" | "redirect_rejected" };

const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
  /^fe80:/i,
];

function parsePreviewUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (err: unknown) {
    if (err instanceof TypeError) return null;
    console.warn("[workflow] Unexpected preview URL parse failure", err instanceof Error ? err.name : "UnknownError");
    return null;
  }
}

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(normalized));
}

function hasRedirectHint(parsed: URL): boolean {
  const haystack = `${parsed.pathname} ${parsed.search}`.toLowerCase();
  return (
    haystack.includes("redirect") ||
    haystack.includes("next=http") ||
    haystack.includes("url=http") ||
    haystack.includes("to=http")
  );
}

export function validatePreviewUrl(input: PreviewPolicyInput): PreviewPolicyResult {
  const parsed = parsePreviewUrl(input.url);
  if (!parsed) return { ok: false, code: "invalid_url" };
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, code: "disallowed_protocol" };
  }
  if (hasRedirectHint(parsed)) {
    return { ok: false, code: "redirect_rejected" };
  }
  if (parsed.hostname !== "localhost" && isPrivateHost(parsed.hostname)) {
    return { ok: false, code: "disallowed_host" };
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;
  if (!input.allowedPorts.includes(port)) {
    return { ok: false, code: "disallowed_port" };
  }
  return { ok: true, url: parsed.toString(), port };
}

export function createPreviewRef(input: PreviewRefInput): {
  label: string;
  url: string;
  port: number;
  status: "approved";
} {
  const validated = validatePreviewUrl(input);
  if (!validated.ok) {
    throw new Error("Preview URL is not allowed");
  }
  return {
    label: input.label,
    url: validated.url,
    port: validated.port,
    status: "approved",
  };
}
