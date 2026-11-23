#!/usr/bin/env node
// Prints the pull request's own base branch.
//
// In a GitHub native stack, the pull_request event's base_ref names the stack
// trunk (main) even when the layer targets its parent branch. Diffing a layer
// against base_ref then counts every lower layer, so PR Size and the added-line
// pattern scan judge the wrong change. The REST API reports the real base.
// Any lookup problem falls back to the event's base_ref, which is stricter
// (a larger diff), never looser.

const SAFE_REF = /^(?!.*\.\.)(?!.*\/\/)(?![./-])(?!.*[./]$)[A-Za-z0-9._/-]{1,200}$/;
const PR_NUMBER = /^[1-9][0-9]{0,8}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export async function resolvePrBase({ apiUrl, repo, prNumber, token, fallback, fetchImpl = fetch, log = console.error }) {
  if (!SAFE_REF.test(fallback ?? "")) throw new Error("Invalid fallback base ref");
  const fall = (why) => {
    log(`::warning::Could not read this PR's base branch (${why}); diffing against ${fallback}.`);
    return fallback;
  };
  if (!PR_NUMBER.test(String(prNumber ?? "")) || !REPO.test(repo ?? "")) return fall("no pull request context");

  let response;
  try {
    response = await fetchImpl(`${apiUrl}/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return fall(error instanceof Error ? error.name : "request failed");
  }
  if (!response.ok) return fall(`HTTP ${response.status}`);

  let body;
  try {
    body = await response.json();
  } catch (error) {
    return fall(error instanceof Error ? error.name : "unreadable response");
  }
  const ref = body?.base?.ref;
  if (typeof ref !== "string" || !SAFE_REF.test(ref)) return fall("missing or unsafe base ref");
  if (ref !== fallback) log(`PR base is ${ref} (event base_ref is ${fallback}).`);
  return ref;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = await resolvePrBase({
    apiUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    repo: process.env.GITHUB_REPOSITORY,
    prNumber: process.env.PR_NUMBER,
    token: process.env.GH_TOKEN,
    fallback: process.env.FALLBACK_BASE_REF,
  });
  process.stdout.write(`${ref}\n`);
}
