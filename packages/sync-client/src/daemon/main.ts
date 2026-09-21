import { startDaemon } from "./index.js";

startDaemon().catch((err: unknown) => {
  console.error("Daemon failed to start:", err);
  process.exit(1);
});
