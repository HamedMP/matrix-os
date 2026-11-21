// Native-stack workflow contexts may name trunk. Verify the individual PR's
// immutable head and parent through GitHub before measuring its own diff.
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";

async function main() {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const number = process.env.PR_NUMBER ?? "";
  const expectedHead = process.env.PR_HEAD_SHA ?? "";
  const reviewBase = process.env.REVIEW_BASE_SHA ?? "";
  const sha = /^[a-f0-9]{40}$/;
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || !/^[1-9][0-9]{0,8}$/.test(number) || !sha.test(expectedHead) || !sha.test(reviewBase) || !process.env.GITHUB_OUTPUT) {
    throw new Error("Invalid PR size context");
  }
  const options = { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
  const pull = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/pulls/${number}`], options));
  const base = pull?.base?.sha;
  if (pull?.head?.sha !== expectedHead || !sha.test(base ?? "")) throw new Error("PR size metadata changed or is invalid");
  // Keep main's shared CI review-base contract, but require it to match the
  // independently verified live parent before the scanner can consume it.
  if (base !== reviewBase) throw new Error("PR review base changed or is invalid");
  const checkedOut = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
  if (checkedOut !== expectedHead) throw new Error("PR size checkout does not match its head");
  // checkout's complete history contains the base. Fail closed if a concurrent
  // parent rewrite made it unavailable; never fall back to a cumulative diff.
  execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], options);
  await appendFile(process.env.GITHUB_OUTPUT, `base_sha=${base}\n`);
}

await main().catch(error => {
  console.error("PR layer base could not be verified:", error instanceof Error ? error.name : "UnknownError");
  process.exitCode = 1;
});
