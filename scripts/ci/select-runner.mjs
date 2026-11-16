// Chooses where ci.yml's unit, pattern and browser jobs run (specs/633-ci-runner-pool).
// Admit a run only with a fresh heartbeat and four idle slots; its seven jobs may queue.
// Fork source never reaches the pool: fork PRs, and manual dispatches
// (which can check out a fork PR's merge), always run hosted.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const POOL_LABEL = "matrix-ci";
export const HOSTED_LABEL = "ubuntu-latest";
export const BROWSER_HOSTED_LABEL = "ubuntu-24.04";
const MIN_IDLE_SLOTS = 4;
const MAX_HEARTBEAT_AGE_SECONDS = 180;
const MAX_CLOCK_SKEW_SECONDS = 60;

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const runner = selectPoolRunner({
    heartbeat: process.env.POOL_HEARTBEAT,
    now: Math.floor(Date.now() / 1000),
    eventName: process.env.EVENT_NAME,
    headRepository: process.env.HEAD_REPOSITORY,
    repository: process.env.REPOSITORY,
  });
  const browserRunner = runner === POOL_LABEL ? POOL_LABEL : BROWSER_HOSTED_LABEL;
  console.log(`Unit/pattern jobs: ${runner}; browser jobs: ${browserRunner} (pool heartbeat: ${process.env.POOL_HEARTBEAT || "none"}).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `source_runner=${runner}\nbrowser_runner=${browserRunner}\n`);
}
