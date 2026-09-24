import { startDaemon } from "./index.js";

startDaemon().catch((err: unknown) => {
  console.error(
    "Daemon failed to start:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
