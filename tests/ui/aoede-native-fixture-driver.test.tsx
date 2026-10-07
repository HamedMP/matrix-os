// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ShellAoedeHost } from "../../shell/src/components/ShellAoedeHost";
import { scenarioById } from "../fixtures/aoede/ui-fixture/src/scenarios";
import { driveScenario } from "../fixtures/aoede/ui-fixture/src/driver";
import { createFixtureBackend, createFixtureEvidence } from "../fixtures/aoede/ui-fixture/src/fixture-backend";
import { createFixtureVoiceFactory } from "../fixtures/aoede/ui-fixture/src/fixture-media";

afterEach(() => { cleanup(); localStorage.clear(); });
it("settles native evidence only after the simulated session renders both captions", async () => {
  const scenario = scenarioById("native-live");
  const evidence = createFixtureEvidence();
  const backend = createFixtureBackend({ detail: scenario.detail(), bootstrap: scenario.bootstrap, evidence });
  render(<ShellAoedeHost userId="user_aoede_fixture" runtimeSlot="fixture" surface="web_desktop" supported
    fetcher={backend.fetcher} controllerDeps={{ voiceFactory: createFixtureVoiceFactory(scenario.media!, evidence) }}>
    <div>Workspace</div>
  </ShellAoedeHost>);
  const result = await driveScenario(scenario);
  expect(result).toMatchObject({ ok: true, errors: [] });
  expect(evidence.snapshot().media.some(line => line.startsWith("startVoice:"))).toBe(true);
  expect(screen.getByText("Build a habit tracker, and let's keep talking.")).toBeTruthy();
  expect(screen.getByText("I've accepted the task in Chat. What would you like to track?")).toBeTruthy();
}, 30_000);
