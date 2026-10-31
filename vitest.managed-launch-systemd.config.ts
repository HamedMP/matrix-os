import { defineConfig } from "vitest/config";
/** Required explicit Linux transport lane. Missing prerequisites fail; never collected as an optional/skipped unit pass. */
export default defineConfig({ resolve: { conditions: ["node"] }, test: { environment: "node", include: ["tests/required/managed-launch-systemd.required.ts"], testTimeout: 20000 } });
