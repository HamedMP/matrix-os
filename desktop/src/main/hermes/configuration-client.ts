import {
  HermesConfigurationChangeRequestSchema,
  HermesConfigurationSchema,
  HermesCredentialRemoveRequestSchema,
  HermesCredentialSetRequestSchema,
  HermesEnvironmentSchema,
  HermesMutationResponseSchema,
  type HermesConfiguration,
  type HermesConfigurationChangeRequest,
  type HermesCredentialRemoveRequest,
  type HermesCredentialSetRequest,
  type HermesEnvironment,
} from "@matrix-os/contracts";
import type { AuthService } from "../auth/auth-service";

const RESPONSE_LIMIT_BYTES = 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 15_000;
const READ_ERROR = "Hermes configuration is unavailable.";
const WRITE_ERROR = "Hermes configuration could not be saved.";

export type HermesFetch = (input: string, init?: RequestInit) => Promise<Response>;

function runtimeUrl(auth: AuthService, path: string): string {
  const url = new URL(path, auth.getGatewayOrigin());
  const runtimeSlot = auth.getStatus().runtimeSlot;
  if (runtimeSlot !== "primary") url.searchParams.set("runtime", runtimeSlot);
  return url.toString();
}

async function boundedJson(response: Response, errorMessage: string): Promise<unknown> {
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > RESPONSE_LIMIT_BYTES) {
    throw new Error(errorMessage);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    console.warn(
      "Hermes Desktop response parsing failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new Error(errorMessage);
  }
}

async function request(
  auth: AuthService,
  path: string,
  init: RequestInit,
  timeoutMs: number,
  errorMessage: string,
  fetchFn: HermesFetch,
): Promise<unknown> {
  const token = auth.getToken();
  if (!token) throw new Error(errorMessage);
  let response: Response;
  try {
    response = await fetchFn(runtimeUrl(auth, path), {
      ...init,
      redirect: "error",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...init.headers,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    console.warn(
      "Hermes Desktop request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    throw new Error(errorMessage);
  }
  if (!response.ok) throw new Error(errorMessage);
  return boundedJson(response, errorMessage);
}

export async function fetchHermesConfiguration(
  auth: AuthService,
  fetchFn: HermesFetch = fetch,
): Promise<HermesConfiguration> {
  const parsed = HermesConfigurationSchema.safeParse(await request(
    auth,
    "/api/hermes/configuration",
    { method: "GET" },
    READ_TIMEOUT_MS,
    READ_ERROR,
    fetchFn,
  ));
  if (!parsed.success) throw new Error(READ_ERROR);
  return parsed.data;
}

export async function fetchHermesEnvironment(
  auth: AuthService,
  fetchFn: HermesFetch = fetch,
): Promise<HermesEnvironment> {
  const parsed = HermesEnvironmentSchema.safeParse(await request(
    auth,
    "/api/hermes/env",
    { method: "GET" },
    READ_TIMEOUT_MS,
    READ_ERROR,
    fetchFn,
  ));
  if (!parsed.success) throw new Error(READ_ERROR);
  return parsed.data;
}

async function mutate<T>(
  auth: AuthService,
  path: string,
  method: "PUT" | "DELETE",
  rawRequest: T,
  requestSchema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  fetchFn: HermesFetch,
): Promise<{ ok: true }> {
  const parsedRequest = requestSchema.safeParse(rawRequest);
  if (!parsedRequest.success) throw new Error(WRITE_ERROR);
  const parsedResponse = HermesMutationResponseSchema.safeParse(await request(
    auth,
    path,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parsedRequest.data),
    },
    WRITE_TIMEOUT_MS,
    WRITE_ERROR,
    fetchFn,
  ));
  if (!parsedResponse.success) throw new Error(WRITE_ERROR);
  return { ok: true };
}

export function updateHermesConfiguration(
  auth: AuthService,
  requestValue: HermesConfigurationChangeRequest,
  fetchFn: HermesFetch = fetch,
): Promise<{ ok: true }> {
  return mutate(
    auth,
    "/api/hermes/configuration",
    "PUT",
    requestValue,
    HermesConfigurationChangeRequestSchema,
    fetchFn,
  );
}

export function setHermesCredential(
  auth: AuthService,
  requestValue: HermesCredentialSetRequest,
  fetchFn: HermesFetch = fetch,
): Promise<{ ok: true }> {
  return mutate(auth, "/api/hermes/env", "PUT", requestValue, HermesCredentialSetRequestSchema, fetchFn);
}

export function removeHermesCredential(
  auth: AuthService,
  requestValue: HermesCredentialRemoveRequest,
  fetchFn: HermesFetch = fetch,
): Promise<{ ok: true }> {
  return mutate(auth, "/api/hermes/env", "DELETE", requestValue, HermesCredentialRemoveRequestSchema, fetchFn);
}
