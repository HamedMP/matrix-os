import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const GATEWAYS = ["matrix-funded-preview", "matrix-funded-production"];
const MAX_RESPONSE_BYTES = 65_536;

function validate({ accountId, token, gatewayId }) {
  if (!/^[a-f0-9]{32}$/.test(accountId ?? "") || !GATEWAYS.includes(gatewayId)
    || typeof token !== "string" || token.length < 32 || token.length > 4096
    || token !== token.trim() || /[\r\n]/.test(token)) {
    throw new Error("Invalid inspection configuration");
  }
}

async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Invalid inspection response");
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Invalid inspection response");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    reader.releaseLock();
  }
}

/** Verify identity only; the returned allowlist never includes token values or names. */
async function inspectTokenIdentity({ accountId, token }, fetcher) {
  const attempts = [];
  for (const ownership of ["user", "account"]) {
    const endpoint = ownership === "user" ? "user/tokens/verify" : `accounts/${accountId}/tokens/verify`;
    let response;
    let data;
    try {
      response = await fetcher(`https://api.cloudflare.com/client/v4/${endpoint}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { authorization: `Bearer ${token}` },
      });
      data = await readJson(response);
    } catch (error) {
      // Exceptions and provider bodies can contain credentials; emit fixed categories only.
      const errorCategory = error instanceof DOMException && error.name === "TimeoutError"
        ? "timeout" : error instanceof TypeError ? "network" : error instanceof SyntaxError ? "json" : "body";
      attempts.push({ ownership, errorCategory });
      continue;
    }
    const identity = data?.result;
    if (response.ok && data?.success === true && typeof identity?.id === "string"
      && /^[a-f0-9]{32}$/.test(identity.id) && identity.id !== token
      && ["active", "disabled", "expired"].includes(identity.status)) {
      return { verified: true, ownership, id: identity.id, status: identity.status };
    }
    attempts.push({ ownership, httpStatus: response.status });
  }
  return { verified: false, attempts };
}

/** GET-only operator diagnostic. Never return provider bodies or filter values. */
export async function inspectGatewayMetadata(config, fetcher = fetch) {
  validate(config);
  const result = { gatewayId: config.gatewayId, readable: false };
  let response;
  try {
    response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai-gateway/gateways/${config.gatewayId}`, {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${config.token}` },
    });
  } catch (error) {
    // Fetch exceptions can contain credentials; emit a fixed diagnostic only.
    const errorCategory = error instanceof DOMException && error.name === "TimeoutError"
      ? "timeout" : error instanceof TypeError ? "network" : "unknown";
    return { ...result, transportFailed: true, errorCategory };
  }
  result.httpStatus = response.status;
  let data;
  try {
    data = await readJson(response);
  } catch (error) {
    return { ...result, invalidResponse: true, errorCategory: error instanceof SyntaxError ? "json" : "body" };
  }
  const errorCodes = Array.isArray(data?.errors)
    ? data.errors.slice(0, 20).flatMap(error => Number.isSafeInteger(error?.code) ? [error.code] : []) : [];
  if (!response.ok || data?.success !== true || data?.result?.id !== config.gatewayId) {
    return { ...result, errorCodes };
  }
  const gateway = data.result;
  return {
    ...result, readable: true,
    configurationSha256: createHash("sha256").update(JSON.stringify(gateway)).digest("hex"),
    authenticationRequired: typeof gateway.authentication === "boolean" ? gateway.authentication : null,
    collectLogs: typeof gateway.collect_logs === "boolean" ? gateway.collect_logs : null,
    spendRuleCount: Array.isArray(gateway.spend_limits?.rules) ? gateway.spend_limits.rules.length : null,
  };
}

export async function runReadOnlyInspection(env, fetcher = fetch) {
  if (env.GITHUB_REF !== "refs/heads/main") throw new Error("Reviewed main source required");
  const match = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/([a-f0-9]{32})\/matrix-funded-production\/anthropic\/?$/.exec(env.CLOUDFLARE_AI_GATEWAY_URL ?? "");
  if (!match || match[1] !== env.CLOUDFLARE_ACCOUNT_ID) throw new Error("Invalid inspection configuration");
  const credential = { accountId: match[1], token: env.CLOUDFLARE_API_TOKEN };
  validate({ ...credential, gatewayId: "matrix-funded-production" });
  const tokenIdentity = await inspectTokenIdentity(credential, fetcher);
  const results = [];
  for (const gatewayId of GATEWAYS) {
    results.push(await inspectGatewayMetadata({ ...credential, gatewayId }, fetcher));
  }
  return { observedAt: new Date().toISOString(), readOnly: true, tokenIdentity, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runReadOnlyInspection(process.env);
    console.log(JSON.stringify(report));
    if (!report.tokenIdentity.verified || report.tokenIdentity.status !== "active"
      || report.results.some(result => !result.readable)) process.exitCode = 1;
  } catch (error) {
    console.error("Cloudflare read-only inspection could not run; no configuration was changed.", {
      errorCategory: error instanceof Error ? "configuration" : "unknown",
    });
    process.exitCode = 1;
  }
}
