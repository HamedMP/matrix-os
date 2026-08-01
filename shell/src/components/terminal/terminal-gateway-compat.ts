export interface TerminalCanonicalGridSize {
  cols: number;
  rows: number;
}

export type TerminalProtocolMode =
  | "probing"
  | "canonical"
  | "canonical-compatibility"
  | "legacy-compatibility"
  | "incompatible";

export interface TerminalProtocolState {
  mode: TerminalProtocolMode;
  sessionId: string;
  canonicalSize: TerminalCanonicalGridSize | null;
}

export type TerminalProtocolEvent =
  | { type: "attached-canonical"; size: TerminalCanonicalGridSize }
  | { type: "metadata-canonical"; size: TerminalCanonicalGridSize }
  | { type: "metadata-legacy" }
  | { type: "metadata-error" }
  | { type: "session-change"; sessionId: string; canonical: boolean };

export type TerminalGatewayCompatibility =
  | { kind: "canonical-compatibility"; size: TerminalCanonicalGridSize }
  | { kind: "legacy-compatibility" }
  | { kind: "incompatible" }
  | { kind: "cancelled" };

export const TERMINAL_CANONICAL_SIZE_PROBE_ATTEMPTS = 3;
export const TERMINAL_CANONICAL_SIZE_SETTLE_MS = 650;
export const TERMINAL_METADATA_FETCH_TIMEOUT_MS = 2_500;
export const MAX_TERMINAL_SESSION_METADATA_BYTES = 256 * 1024;
export const MAX_TERMINAL_SESSION_METADATA_ROWS = 200;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ResolveTerminalGatewayCompatibilityOptions {
  gatewayUrl: string;
  sessionId: string;
  signal: AbortSignal;
  fetchImpl?: FetchLike;
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface SessionMetadataObservation {
  kind: "canonical" | "missing" | "invalid";
  size?: TerminalCanonicalGridSize;
}

export function initialTerminalProtocolState(
  sessionId: string,
  canonical: boolean,
): TerminalProtocolState {
  return {
    mode: canonical ? "probing" : "legacy-compatibility",
    sessionId,
    canonicalSize: null,
  };
}

export function transitionTerminalProtocolState(
  state: TerminalProtocolState,
  event: TerminalProtocolEvent,
): TerminalProtocolState {
  switch (event.type) {
    case "session-change":
      return initialTerminalProtocolState(event.sessionId, event.canonical);
    case "attached-canonical":
      return { mode: "canonical", sessionId: state.sessionId, canonicalSize: event.size };
    case "metadata-canonical":
      return {
        mode: "canonical-compatibility",
        sessionId: state.sessionId,
        canonicalSize: event.size,
      };
    case "metadata-legacy":
      return { mode: "legacy-compatibility", sessionId: state.sessionId, canonicalSize: null };
    case "metadata-error":
      return { mode: "incompatible", sessionId: state.sessionId, canonicalSize: null };
  }
}

export function terminalProtocolUsesSoftClient(state: TerminalProtocolState): boolean {
  return state.mode !== "legacy-compatibility" && state.mode !== "incompatible";
}

export function terminalProtocolHasCanonicalGrid(state: TerminalProtocolState): boolean {
  return state.mode === "canonical" || state.mode === "canonical-compatibility";
}

export function isTerminalCanonicalGridSize(value: unknown): value is TerminalCanonicalGridSize {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const cols = (value as { cols?: unknown }).cols;
  const rows = (value as { rows?: unknown }).rows;
  return Number.isInteger(cols) && (cols as number) >= 1 && (cols as number) <= 500
    && Number.isInteger(rows) && (rows as number) >= 1 && (rows as number) <= 200;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function abortableWait(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function observeSessionMetadata(
  response: Response,
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionMetadataObservation> {
  if (!response.ok) {
    return { kind: "invalid" };
  }
  const raw = await readBoundedResponseText(response, signal);
  if (raw === null) {
    return { kind: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    console.warn("[terminal] invalid session metadata JSON", {
      category: err instanceof SyntaxError ? "syntax" : "unexpected",
    });
    return { kind: "invalid" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const sessions = (parsed as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions) || sessions.length > MAX_TERMINAL_SESSION_METADATA_ROWS) {
    return { kind: "invalid" };
  }
  const session = sessions.find((candidate) => (
    Boolean(candidate)
    && typeof candidate === "object"
    && !Array.isArray(candidate)
    && (candidate as { name?: unknown }).name === sessionId
  ));
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return { kind: "invalid" };
  }
  if (!Object.prototype.hasOwnProperty.call(session, "canonicalSize")) {
    return { kind: "missing" };
  }
  const canonicalSize = (session as { canonicalSize?: unknown }).canonicalSize;
  if (!isTerminalCanonicalGridSize(canonicalSize)) {
    return { kind: "invalid" };
  }
  return { kind: "canonical", size: canonicalSize };
}

function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().then(undefined, () => {
        console.warn("[terminal] failed to cancel timed out session metadata response");
      });
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  if (!response.body) {
    const raw = await response.text();
    return new TextEncoder().encode(raw).byteLength <= MAX_TERMINAL_SESSION_METADATA_BYTES
      ? raw
      : null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let readerCancelled = false;
  try {
    while (true) {
      const { done, value } = await readStreamChunk(reader, signal);
      if (done) {
        break;
      }
      if (!value || value.byteLength === 0) {
        continue;
      }
      totalBytes += value.byteLength;
      if (totalBytes > MAX_TERMINAL_SESSION_METADATA_BYTES) {
        readerCancelled = true;
        void reader.cancel().then(undefined, () => {
          console.warn("[terminal] failed to cancel oversized session metadata response");
        });
        return null;
      }
      chunks.push(value);
    }
  } finally {
    if (!readerCancelled && !signal.aborted) {
      reader.releaseLock();
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function observeSessionMetadataWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  sessionId: string,
  parentSignal: AbortSignal,
): Promise<SessionMetadataObservation> {
  if (parentSignal.aborted) {
    throw abortError();
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(), TERMINAL_METADATA_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    return await observeSessionMetadata(response, sessionId, controller.signal);
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", onParentAbort);
  }
}

export async function resolveTerminalGatewayCompatibility(
  options: ResolveTerminalGatewayCompatibilityOptions,
): Promise<TerminalGatewayCompatibility> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.wait ?? abortableWait;
  const url = `${options.gatewayUrl}/api/terminal/sessions`;
  let observedCanonicalSize = false;
  let latestSize: TerminalCanonicalGridSize | null = null;

  try {
    for (let attempt = 0; attempt < TERMINAL_CANONICAL_SIZE_PROBE_ATTEMPTS; attempt += 1) {
      const observation = await observeSessionMetadataWithTimeout(
        fetchImpl,
        url,
        options.sessionId,
        options.signal,
      );
      if (observation.kind === "invalid") {
        return { kind: "incompatible" };
      }
      if (observation.kind === "canonical") {
        observedCanonicalSize = true;
        latestSize = observation.size ?? null;
      } else if (observedCanonicalSize) {
        // Capability was established and then disappeared. Never downgrade a
        // sizing-aware gateway to legacy behavior on contradictory metadata.
        return { kind: "incompatible" };
      }
      if (attempt + 1 < TERMINAL_CANONICAL_SIZE_PROBE_ATTEMPTS) {
        await wait(TERMINAL_CANONICAL_SIZE_SETTLE_MS, options.signal);
      }
    }
  } catch (err: unknown) {
    if (options.signal.aborted && isAbortError(err)) {
      return { kind: "cancelled" };
    }
    return { kind: "incompatible" };
  }

  return latestSize
    ? { kind: "canonical-compatibility", size: latestSize }
    : { kind: "legacy-compatibility" };
}
