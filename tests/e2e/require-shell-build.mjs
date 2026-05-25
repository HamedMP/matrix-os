import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const shellBuild = resolve(here, "../../shell/.next");

try {
  await access(shellBuild, constants.R_OK);
} catch {
  console.error(
    "Missing shell/.next build. Run `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_bWF0cml4b3MudGVzdCQ= pnpm --dir shell build` before onboarding E2E.",
  );
  process.exit(1);
}
