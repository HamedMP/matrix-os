import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _electron, type ElectronApplication, type Page } from "playwright";
import { ProviderSettingsSnapshotSchema } from "@matrix-os/contracts";
import { deriveChatProviderConnectionState } from "../../../packages/ui/src/agents-providers/ChatProviderConnections";

const root = resolve(__dirname, "../../..");
const profile = process.env.MATRIX_CHAT_LIVE_QA_PROFILE;
const output = join(root, "output/playwright/eng-60");
const suite = profile ? describe : describe.skip;
let app: ElectronApplication;
let page: Page;

// Read-only provider acceptance: does not log in/out a coding provider or send a model turn.
suite("Electron Desktop Chat against an authenticated runtime", () => {
  beforeAll(async () => {
    mkdirSync(output, { recursive: true });
    const executablePath = createRequire(join(root, "desktop/package.json"))("electron") as string;
    app = await _electron.launch({ executablePath, args: [join(root, "desktop/out/main/index.js")],
      env: { ...process.env, OPERATOR_USER_DATA_DIR: profile! },
    });
    page = await app.firstWindow();
  }, 60_000);

  afterAll(async () => { await app?.close(); });

  it("matches fresh runtime connection evidence without offering an unsupported login", async () => {
    try {
      const auth = await page.evaluate(() => window.operator.invoke("auth:status", {}));
      expect(auth.signedIn, "The isolated QA profile requires sign-in").toBe(true);
      if (process.env.MATRIX_CHAT_LIVE_QA_SLOT && auth.runtimeSlot !== process.env.MATRIX_CHAT_LIVE_QA_SLOT) {
        await page.evaluate((slot) => window.operator.invoke("runtime:select", { slot }), process.env.MATRIX_CHAT_LIVE_QA_SLOT);
      }
      const evidence = await page.evaluate(async () => {
        const identity = await window.operator.invoke("auth:status", {});
        const suffix = identity.runtimeSlot === "primary" ? "" : `&runtime=${encodeURIComponent(identity.runtimeSlot)}`;
        const read = async (path: string) => {
          const response = await fetch(`${identity.platformHost}${path}${suffix}`, { signal: AbortSignal.timeout(15_000) });
          if (!response.ok) throw new Error(`QA read failed (${response.status})`);
          return response.json();
        };
        const snapshot = await read("/api/ai/provider-settings?includeCapabilities=true&refresh=true");
        const system = await read("/api/system/info?qa=chat-onboarding");
        const client = await window.operator.invoke("app:get-version", {});
        return { snapshot, runtimeSlot: identity.runtimeSlot, clientCommit: client.source?.commit,
          runtimeVersion: system.runtimeVersion ?? system.version, runtimeCommit: system.build?.sha };
      });
      if (process.env.MATRIX_EXPECTED_CLIENT_COMMIT) expect(evidence.clientCommit).toBe(process.env.MATRIX_EXPECTED_CLIENT_COMMIT);
      const snapshot = ProviderSettingsSnapshotSchema.parse(evidence.snapshot);
      const connectionState = deriveChatProviderConnectionState(snapshot);
      const provenance = {
        runtimeSlot: evidence.runtimeSlot, clientCommit: evidence.clientCommit,
        runtimeVersion: evidence.runtimeVersion, runtimeCommit: evidence.runtimeCommit, connectionState,
        harnesses: snapshot.harnesses.map(({ harness, authState, enabled }) => ({ harness, authState, enabled })),
        sources: snapshot.accessSources.map(({ kind, readiness }) => ({ kind, state: readiness.state, safeReason: readiness.safeReason })),
      };
      writeFileSync(join(output, "live-provenance.json"), JSON.stringify(provenance, null, 2));
      expect(connectionState).toBe(process.env.MATRIX_CHAT_LIVE_EXPECT_CONNECTION ?? "connected");
      const later = page.getByRole("button", { name: "Later", exact: true });
      if (await later.isVisible()) await later.click();
      const chat = page.getByRole("dialog", { name: "Chat window", exact: true });
      await chat.waitFor({ timeout: 20_000 });
      expect(await page.getByRole("button", { name: "Connect Claude Code", exact: true }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Connect Codex", exact: true }).count()).toBe(0);
      if (connectionState === "unknown") {
        // Unknown Settings evidence retains normal Chat or its existing canonical
        // recovery; the new onboarding must not install a connection-status gate.
        const status = chat.getByRole("heading", { name: "Connection status unavailable", exact: true });
        const starter = chat.getByRole("button", { name: "Explore and understand code", exact: true });
        const recovery = chat.getByText("Chat unavailable", { exact: true });
        await starter.or(recovery).first().waitFor();
        expect(await status.count()).toBe(0);
        writeFileSync(join(output, "live-provenance.json"), JSON.stringify({ ...provenance,
          chatPresentation: await recovery.isVisible() ? "canonical_chat_unavailable" : "normal_chat_with_unknown_connection",
        }, null, 2));
      }
      expect(await chat.count()).toBe(1);
      await page.screenshot({ path: join(output, `electron-live-${connectionState}.png`) });
    } catch (error) {
      await page.screenshot({ path: join(output, "live-failure.png") });
      throw error;
    }
  }, 60_000);
});
