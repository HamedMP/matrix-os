#!/usr/bin/env node

const DEFAULT_REQUIRED_SCORE = 5;
const DEFAULT_TRUSTED_AUTHOR_PATTERN = /greptile/i;

export function parseConfidenceScore(body) {
  if (typeof body !== "string") return null;
  const match = body.match(/confidence\s+score:\s*([0-5])\s*\/\s*5/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

export function isTrustedGreptileAuthor(author) {
  if (!author || typeof author.login !== "string") return false;
  return DEFAULT_TRUSTED_AUTHOR_PATTERN.test(author.login);
}

export function findLatestGreptileConfidenceScore(items) {
  const scoredItems = [];
  for (const item of items) {
    const score = parseConfidenceScore(item.body);
    if (score === null) continue;
    if (!isTrustedGreptileAuthor(item.author)) continue;
    scoredItems.push({
      score,
      author: item.author.login,
      source: item.source,
      url: item.url,
      timestamp: new Date(item.updatedAt ?? item.createdAt ?? 0).getTime(),
    });
  }
  scoredItems.sort((a, b) => b.timestamp - a.timestamp);
  return scoredItems[0] ?? null;
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`github_api_failed:${response.status}`);
  }
  return response.json();
}

async function fetchPaged(url, token) {
  const items = [];
  let page = 1;
  while (page <= 10) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("per_page", "100");
    pageUrl.searchParams.set("page", String(page));
    const pageItems = await fetchJson(pageUrl, token);
    if (!Array.isArray(pageItems)) throw new Error("github_api_unexpected_response");
    items.push(...pageItems);
    if (pageItems.length < 100) break;
    page += 1;
  }
  return items;
}

function normalizeComment(comment, source) {
  return {
    source,
    body: comment.body,
    author: comment.user,
    url: comment.html_url,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at ?? comment.submitted_at ?? comment.created_at,
  };
}

async function fetchReviewItems({ owner, repo, prNumber, token }) {
  const base = `https://api.github.com/repos/${owner}/${repo}`;
  const [issueComments, reviews, reviewComments] = await Promise.all([
    fetchPaged(`${base}/issues/${prNumber}/comments`, token),
    fetchPaged(`${base}/pulls/${prNumber}/reviews`, token),
    fetchPaged(`${base}/pulls/${prNumber}/comments`, token),
  ]);

  return [
    ...issueComments.map((comment) => normalizeComment(comment, "issue_comment")),
    ...reviews.map((review) => normalizeComment(review, "pull_review")),
    ...reviewComments.map((comment) => normalizeComment(comment, "review_comment")),
  ];
}

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key.startsWith("--") || !value) continue;
    args.set(key.slice(2), value);
    index += 1;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const repository = args.get("repo") ?? process.env.GITHUB_REPOSITORY;
  const prNumber = args.get("pr") ?? process.env.PR_NUMBER;
  const requiredScore = Number.parseInt(process.env.GREPTILE_REQUIRED_SCORE ?? String(DEFAULT_REQUIRED_SCORE), 10);
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  if (!repository || !repository.includes("/")) throw new Error("missing_repo");
  if (!prNumber) throw new Error("missing_pr_number");
  if (!token) throw new Error("missing_github_token");
  if (!Number.isInteger(requiredScore) || requiredScore < 0 || requiredScore > 5) {
    throw new Error("invalid_required_score");
  }

  const [owner, repo] = repository.split("/", 2);
  const reviewItems = await fetchReviewItems({ owner, repo, prNumber, token });
  const latest = findLatestGreptileConfidenceScore(reviewItems);

  if (!latest) {
    console.error("No trusted Greptile confidence score found on this PR.");
    process.exitCode = 1;
    return;
  }

  console.log(`Latest Greptile confidence score: ${latest.score}/5 from ${latest.author} (${latest.source})`);
  if (latest.url) console.log(latest.url);
  if (latest.score !== requiredScore) {
    console.error(`Greptile confidence must be ${requiredScore}/5 before merge.`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : "greptile_confidence_check_failed");
    process.exitCode = 1;
  });
}
