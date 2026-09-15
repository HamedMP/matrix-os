import { safeStorage } from "electron";

// Only this disposable E2E profile contains the synthetic stub-token-1.
// Headless Linux has no keyring; use the same fixture backend on both launches.
if (process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);

await import("../../../../desktop/out/main/index.js");
