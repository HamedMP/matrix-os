import { safeStorage } from "electron";

// This entrypoint is used only by the download E2E's disposable profile and
// synthetic stub-token-1 credential. Headless Linux runners have no keyring.
// Set the same test-only backend before both launches so the fixture can be
// encrypted and then read on restart. Production entrypoints are unchanged.
if (process.platform === "linux") safeStorage.setUsePlainTextEncryption(true);

await import("../../../../desktop/out/main/index.js");
