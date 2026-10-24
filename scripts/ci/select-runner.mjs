// Chooses where ci.yml's unit shards run (specs/633-ci-runner-pool). The dedicated host's pool takes
// full-suite runs only while its heartbeat is fresh and every shard can start at once; everything
// else, and every fork PR, stays on GitHub-hosted runners.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const POOL_LABEL = "matrix-ci";
export const HOSTED_LABEL = "ubuntu-latest";
export const UNIT_SHARDS = 4;
const MAX_HEARTBEAT_AGE_SECONDS = 180;
const MAX_CLOCK_SKEW_SECONDS = 60;

export function selectUnitRunner({ heartbeat, now, sameRepository, unitScope }) {
  if (sameRepository !== "true" || unitScope !== "full") return HOSTED_LABEL;
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
    sameRepository: process.env.SAME_REPOSITORY,
    unitScope: process.env.UNIT_SCOPE,
  });
  console.log(`Unit shards run on ${runner} (pool heartbeat: ${process.env.POOL_HEARTBEAT || "none"}).`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `unit_runner=${runner}\n`);
}
