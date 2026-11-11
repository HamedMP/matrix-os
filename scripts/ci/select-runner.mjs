// Chooses where ci.yml's unit shards run (specs/633-ci-runner-pool). The dedicated host's pool takes
// a run only while its heartbeat is fresh and every shard can start at once; everything else stays
// on GitHub-hosted runners. Fork source never reaches the pool: fork PRs, and manual dispatches
// (which can check out a fork PR's merge), always run hosted.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const POOL_LABEL = "matrix-ci";
export const HOSTED_LABEL = "ubuntu-latest";
export const UNIT_SHARDS = 4;
const MAX_HEARTBEAT_AGE_SECONDS = 180;
const MAX_CLOCK_SKEW_SECONDS = 60;

function trustedSource({ eventName, headRepository, repository }) {
  if (eventName === "push" || eventName === "merge_group") return true;
  return eventName === "pull_request" && Boolean(repository) && headRepository === repository;
}

export function selectUnitRunner({ heartbeat, now, eventName, headRepository, repository }) {
  if (!trustedSource({ eventName, headRepository, repository })) return HOSTED_LABEL;
  const match = /^([0-9]{1,12}) ([0-9]{1,3})$/u.exec(heartbeat ?? "");
  if (!match) return HOSTED_LABEL;
  const age = now - Number(match[1]);
  if (age > MAX_HEARTBEAT_AGE_SECONDS || age < -MAX_CLOCK_SKEW_SECONDS) return HOSTED_LABEL;
  return Number(match[2]) >= UNIT_SHARDS ? POOL_LABEL : HOSTED_LABEL;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = selectUnitRunner({
    heartbeat: process.env.POOL_HEARTBEAT,
    now: Math.floor(Date.now() / 1000),
    eventName: process.env.EVENT_NAME,
    headRepository: process.env.HEAD_REPOSITORY,
    repository: process.env.REPOSITORY,
  });
  console.log(`Unit shards run on ${runner} (pool heartbeat: ${process.env.POOL_HEARTBEAT || "none"}).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `unit_runner=${runner}\n`);
}
