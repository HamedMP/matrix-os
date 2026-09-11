const MAX_CHECKOUT_RESPONSE_BYTES = 8 * 1024;
const CHECKOUT_TIMEOUT_MS = 10_000;
type PackageId = "usd_5" | "usd_10" | "usd_25";

class AiCreditCheckoutError extends Error {
  constructor() {
    super("Checkout is unavailable.");
    this.name = "AiCreditCheckoutError";
  }
}

function isStripeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com";
  } catch (error) {
    if (!(error instanceof TypeError)) {
      console.warn(
        "[ai-credit] Checkout URL validation failed:",
        error instanceof Error ? error.name : typeof error,
      );
    }
    return false;
  }
}

async function readBoundedCheckoutResponse(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CHECKOUT_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new AiCreditCheckoutError();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new AiCreditCheckoutError();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_CHECKOUT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AiCreditCheckoutError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      console.warn(
        "[ai-credit] Checkout response decoding failed:",
        error instanceof Error ? error.name : typeof error,
      );
    }
    throw new AiCreditCheckoutError();
  }
}

export function currentAiCreditRuntimeSlot(): string {
  if (typeof window === "undefined") return "primary";
  const runtimeSlot = new URLSearchParams(window.location.search).get("runtime");
  return runtimeSlot && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(runtimeSlot) && runtimeSlot.length <= 32
    ? runtimeSlot
    : "primary";
}

export async function openWebAiCreditCheckout(input: {
  packageId: PackageId;
  runtimeSlot?: string;
  requestId: string;
  fetcher?: typeof fetch;
  navigate?: (url: string) => void;
}): Promise<void> {
  const fetcher = input.fetcher ?? fetch;
  const navigate = input.navigate ?? ((url: string) => window.location.assign(url));
  try {
    const response = await fetcher("/billing/ai-credit/checkout", {
      method: "POST",
      credentials: "include",
      signal: AbortSignal.timeout(CHECKOUT_TIMEOUT_MS),
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        packageId: input.packageId,
        runtimeSlot: input.runtimeSlot ?? currentAiCreditRuntimeSlot(),
        requestId: input.requestId,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AiCreditCheckoutError();
    }
    const value = await readBoundedCheckoutResponse(response);
    const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
    if (!isStripeCheckoutUrl(url)) throw new AiCreditCheckoutError();
    navigate(url);
  } catch (error) {
    if (error instanceof AiCreditCheckoutError) throw error;
    console.warn("[ai-credit] Checkout request failed:", error instanceof Error ? error.name : typeof error);
    throw new AiCreditCheckoutError();
  }
}
