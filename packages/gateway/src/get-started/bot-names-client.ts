import {
  GetStartedBotNamesResponseSchema,
  type GetStartedBotNamesRequest,
  type GetStartedBotNamesResponse,
} from "@matrix-os/contracts";
import { readBoundedBody } from "../collaboration/scope-runtime-broker.js";

// Spec 636, Part B: this computer asks the platform for bot name suggestions with
// its machine bearer. The model and its key live on the platform only.

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_MAX_BYTES = 32 * 1024;
const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{32,512}$/;

export class GetStartedBotNameClientError extends Error {
  override readonly name = "GetStartedBotNameClientError";
}

export interface GetStartedBotNameClient {
  suggest(request: GetStartedBotNamesRequest, signal: AbortSignal): Promise<GetStartedBotNamesResponse>;
}

/** The platform origin: https, or http on loopback for local development; nothing after the host. */
function platformOrigin(raw: string | undefined): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  const secure = url.protocol === "https:" || (loopback && url.protocol === "http:");
  return secure && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" ? url : null;
}

/** Null when this computer has no platform link, so the route can answer 503 instead of guessing. */
export function createGetStartedBotNameClient(config: {
  platformUrl: string | undefined;
  token: string | undefined;
  handle: string | undefined;
  fetchImpl?: typeof fetch;
}): GetStartedBotNameClient | null {
  const origin = platformOrigin(config.platformUrl);
  const { token, handle } = config;
  if (!origin || !token || !TOKEN_PATTERN.test(token) || !handle || !HANDLE_PATTERN.test(handle)) return null;
  const url = new URL(`/internal/containers/${handle}/get-started/bot-names`, origin).toString();
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async suggest(request, signal) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { accept: "application/json", authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new GetStartedBotNameClientError(`platform returned HTTP ${response.status}`);
      }
      let text: string;
      try {
        // Read up to the cap and stop: an oversized or endless reply is never buffered.
        text = await readBoundedBody(response, RESPONSE_MAX_BYTES);
      } catch (err) {
        if (err instanceof RangeError) throw new GetStartedBotNameClientError("platform reply too large");
        throw err;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (err) {
        if (err instanceof SyntaxError) throw new GetStartedBotNameClientError("platform reply is not JSON");
        throw err;
      }
      const parsed = GetStartedBotNamesResponseSchema.safeParse(raw);
      if (!parsed.success) throw new GetStartedBotNameClientError("platform reply is not five valid names");
      return parsed.data;
    },
  };
}
