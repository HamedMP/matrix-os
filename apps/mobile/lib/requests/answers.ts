import { z } from "zod/v4";

import { buildGatewayRequestUrl, fetchAuthenticatedResponse } from "./http";

interface ResponseSchema<T> {
  parse(value: unknown): T;
}

interface AnswerRequest<T> {
  url: string;
  token: string;
  schema: ResponseSchema<T>;
  errorMessage: string;
  /** Statuses with which the server refuses the request for a reason the caller tells apart. */
  refusalStatuses: readonly number[];
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Either the validated success body, or a refusal reduced to its status and the
 * server's machine-readable code. The server's wording never travels with it.
 */
export type RequestAnswer<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; code: string | null };

const RefusalCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// Workspace and chat routes answer `{ error: { code } }`; bot routes answer `{ code }`.
const RefusalBodySchema = z.union([
  z.looseObject({ error: z.looseObject({ code: RefusalCodeSchema }) }).transform((body) => body.error.code),
  z.looseObject({ code: RefusalCodeSchema }).transform((body) => body.code),
]);

/**
 * Like `fetchAuthenticatedJson`, for requests whose refusals mean something to
 * the screen. Anything else -- another status, a network failure, a body that
 * does not validate -- still rejects with the generic `errorMessage`.
 */
export function fetchAuthenticatedAnswer<T>({
  schema,
  refusalStatuses,
  ...request
}: AnswerRequest<T>): Promise<RequestAnswer<T>> {
  return fetchAuthenticatedResponse<RequestAnswer<T>>(
    { ...request, expectedStatuses: refusalStatuses },
    async (response) => {
      if (response.ok) return { ok: true, value: schema.parse(await response.json()) };
      return { ok: false, status: response.status, code: await readRefusalCode(response) };
    },
  );
}

async function readRefusalCode(response: Response): Promise<string | null> {
  try {
    const parsed = RefusalBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch (error: unknown) {
    // A refusal without a readable body is still a refusal; its status says which.
    console.warn("[mobile] refusal body unreadable", error instanceof Error ? error.name : "unknown");
    return null;
  }
}

/** The request URL, or null when the gateway address is not a URL at all. */
export function gatewayRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string>,
): string | null {
  try {
    return buildGatewayRequestUrl(baseUrl, path, query);
  } catch (error: unknown) {
    console.warn("[mobile] gateway address is not a URL", error instanceof Error ? error.name : "unknown");
    return null;
  }
}
