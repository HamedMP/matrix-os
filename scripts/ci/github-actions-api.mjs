export const GITHUB_REQUEST_TIMEOUT_MS = 10_000;
export const MAX_GITHUB_RESPONSE_BYTES = 4 * 1024 * 1024;

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export function assertGitHubConfig(repository, token) {
  if (
    !REPOSITORY_PATTERN.test(repository) ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 8192 ||
    /[\0\r\n]/.test(token)
  ) {
    throw new Error("GitHub Actions configuration is invalid");
  }
}

export async function requestGitHubJson(endpoint, options) {
  const response = await requestGitHub(endpoint, options);
  return readBoundedJson(response);
}

export async function requestGitHub(endpoint, {
  token,
  fetchImpl = fetch,
  method = "GET",
  acceptedStatuses = [200],
}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error("GitHub Actions API is unavailable");
  }
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error("GitHub Actions API request failed");
  }
  return response;
}

async function readBoundedJson(response) {
  if (!response.body) throw new Error("GitHub Actions API response is invalid");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_GITHUB_RESPONSE_BYTES) {
        throw new Error("GitHub Actions API response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("GitHub Actions API response is invalid");
    throw error;
  }
}
