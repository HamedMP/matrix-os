// Chooses where ci.yml's unit, pattern and browser jobs run (specs/633-ci-runner-pool).
// Admit a run only with a fresh heartbeat and an idle slot; its seven jobs may queue. A freed slot
// takes the next queued pool job at once, so an idle slot means the pool has no backlog.
// Fork source never reaches the pool: fork PRs, and manual dispatches
// (which can check out a fork PR's merge), always run hosted.
// GitHub resolves `vars` when the run attempt starts, so the heartbeat's age is
// measured from then: this job can wait many minutes for a hosted runner first.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const POOL_LABEL = "matrix-ci";
export const HOSTED_LABEL = "ubuntu-latest";
export const BROWSER_HOSTED_LABEL = "ubuntu-24.04";
const MIN_IDLE_SLOTS = 1;
const MAX_HEARTBEAT_AGE_SECONDS = 180;
const MAX_CLOCK_SKEW_SECONDS = 60;
const ATTEMPT_LOOKUP_TIMEOUT_MS = 10_000;

function trustedSource({ eventName, headRepository, repository }) {
  if (eventName === "push" || eventName === "merge_group") return true;
  return eventName === "pull_request" && Boolean(repository) && headRepository === repository;
}

export function selectPoolRunner({ heartbeat, now, eventName, headRepository, repository }) {
  if (!trustedSource({ eventName, headRepository, repository })) return HOSTED_LABEL;
  const match = /^([0-9]{1,12}) ([0-9]{1,3})$/u.exec(heartbeat ?? "");
  if (!match) return HOSTED_LABEL;
  const age = now - Number(match[1]);
  if (age > MAX_HEARTBEAT_AGE_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) return HOSTED_LABEL;
  return Number(match[2]) >= MIN_IDLE_SLOTS ? POOL_LABEL : HOSTED_LABEL;
}

// When the run attempt started (unix seconds), or `now` when that is unknown;
// falling back only reproduces the stricter old behavior.
export async function heartbeatReadAt({ now, token, apiUrl, repository, runId, runAttempt, fetchImpl = fetch }) {
  if (!token || !apiUrl || !repository || !runId || !runAttempt) return now;
  try {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(ATTEMPT_LOOKUP_TIMEOUT_MS),
    });
    if (!response.ok) {
      console.log(`Run attempt lookup returned ${response.status}; judging the heartbeat by the current time.`);
      return now;
    }
    const started = Math.floor(Date.parse((await response.json()).run_started_at) / 1000);
    return Number.isFinite(started) && started <= now ? started : now;
  } catch (error) {
    console.log(`Run attempt lookup failed (${error instanceof Error ? error.name : "unknown"}); judging the heartbeat by the current time.`);
    return now;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const now = Math.floor(Date.now() / 1000);
  const readAt = await heartbeatReadAt({
    now,
    token: process.env.GITHUB_TOKEN,
    apiUrl: process.env.GITHUB_API_URL,
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  const runner = selectPoolRunner({
    heartbeat: process.env.POOL_HEARTBEAT,
    now: readAt,
    eventName: process.env.EVENT_NAME,
    headRepository: process.env.HEAD_REPOSITORY,
    repository: process.env.REPOSITORY,
  });
  const browserRunner = runner === POOL_LABEL ? POOL_LABEL : BROWSER_HOSTED_LABEL;
  console.log(`Unit/pattern jobs: ${runner}; browser jobs: ${browserRunner} (pool heartbeat: ${process.env.POOL_HEARTBEAT || "none"}, read at ${readAt}, ${now - readAt}s before selection).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `source_runner=${runner}\nbrowser_runner=${browserRunner}\n`);
}
