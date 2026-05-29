import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellBuild = resolve(here, "../../shell/.next");

try {
  await access(shellBuild, constants.R_OK);
} catch (err) {
  const code = err && typeof err === "object" && "code" in err ? err.code : undefined;
  if (code && code !== "ENOENT") {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`shell/.next exists but is not readable (${code}): ${message}`);
    process.exit(1);
  }
  console.error(
    "Missing shell/.next build. Run `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_bWF0cml4b3MudGVzdCQ= pnpm --dir shell build` before onboarding E2E.",
  );
  process.exit(1);
}
