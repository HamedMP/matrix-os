import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createDispatcher,
  type SpawnFn,
} from "../../packages/gateway/src/dispatcher.js";
import { createProvisioner } from "../../packages/gateway/src/provisioner.js";
import type { ServerMessage } from "../../packages/gateway/src/server.js";
import type { KernelEvent } from "@matrix-os/kernel";
import type { SetupPlan } from "../../packages/kernel/src/onboarding.js";

function makeHomePath(): string {
  const dir = resolve(mkdtempSync(join(tmpdir(), "provision-")));
  mkdirSync(join(dir, "system"), { recursive: true });
  return dir;
}

function resultEvent(id: string): KernelEvent {
  return { type: "result", data: { sessionId: id, cost: 0, turns: 1 } };
}

function writePlan(homePath: string, plan: SetupPlan) {
  writeFileSync(join(homePath, "system/setup-plan.json"), JSON.stringify(plan));
}

function readPlan(homePath: string): SetupPlan {
  return JSON.parse(readFileSync(join(homePath, "system/setup-plan.json"), "utf-8"));
}

function makePendingPlan(apps: Array<{ name: string; description: string }>): SetupPlan {
  return {
    role: "student",
    apps,
    skills: [{ name: "summarize", description: "Summarize text" }],
    personality: { vibe: "casual", traits: ["helpful"] },
    status: "pending",
    built: [],
  };
}

describe("T404: Provisioner", () => {
  let homePath: string;

  beforeEach(() => {
    homePath = makeHomePath();
  });

  it("ignores plan with non-pending status", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const messages: ServerMessage[] = [];

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: (msg) => messages.push(msg),
    });

    writePlan(homePath, {
      ...makePendingPlan([{ name: "App", description: "An app" }]),
      status: "complete",
    });

    await provisioner.onSetupPlanChange();

    expect(spawn).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
  });

  it("ignores missing plan file", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: () => {},
    });

    await provisioner.onSetupPlanChange();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("creates DB tasks for each app", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const messages: ServerMessage[] = [];

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: (msg) => messages.push(msg),
    });

    writePlan(homePath, makePendingPlan([
      { name: "Study Planner", description: "Schedule app" },
      { name: "Flashcards", description: "Study cards" },
      { name: "Budget Tracker", description: "Budget app" },
    ]));

    await provisioner.onSetupPlanChange();

    const taskCreated = messages.filter((m) => m.type === "task:created");
    expect(taskCreated).toHaveLength(3);
  });

  it("transitions status: pending -> building -> complete", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: () => {},
    });

    writePlan(homePath, makePendingPlan([
      { name: "App A", description: "First app" },
    ]));

    await provisioner.onSetupPlanChange();

    const finalPlan = readPlan(homePath);
    expect(finalPlan.status).toBe("complete");
    expect(finalPlan.built).toContain("App A");
  });

  it("broadcasts provision:start and provision:complete", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const messages: ServerMessage[] = [];

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: (msg) => messages.push(msg),
    });

    writePlan(homePath, makePendingPlan([
      { name: "App X", description: "X" },
      { name: "App Y", description: "Y" },
    ]));

    await provisioner.onSetupPlanChange();

    const starts = messages.filter((m) => m.type === "provision:start");
    expect(starts).toHaveLength(1);
    expect((starts[0] as { type: "provision:start"; appCount: number }).appCount).toBe(2);

    const completes = messages.filter((m) => m.type === "provision:complete");
    expect(completes).toHaveLength(1);
    const complete = completes[0] as { type: "provision:complete"; total: number; succeeded: number; failed: number };
    expect(complete.total).toBe(2);
    expect(complete.succeeded).toBe(2);
    expect(complete.failed).toBe(0);
  });

  it("handles partial build failures gracefully", async () => {
    let callCount = 0;
    const spawn = vi.fn<SpawnFn>(async function* () {
      callCount++;
      if (callCount === 2) throw new Error("build crashed");
      yield resultEvent("s");
    });

    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const messages: ServerMessage[] = [];

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: (msg) => messages.push(msg),
    });

    writePlan(homePath, makePendingPlan([
      { name: "App A", description: "A" },
      { name: "App B", description: "B" },
      { name: "App C", description: "C" },
    ]));

    await provisioner.onSetupPlanChange();

    const finalPlan = readPlan(homePath);
    expect(finalPlan.status).toBe("complete");
    expect(finalPlan.built).toContain("App A");
    expect(finalPlan.built).not.toContain("App B");
    expect(finalPlan.built).toContain("App C");

    const complete = messages.find((m) => m.type === "provision:complete") as {
      type: "provision:complete"; total: number; succeeded: number; failed: number;
    };
    expect(complete.succeeded).toBe(2);
    expect(complete.failed).toBe(1);
  });

  it("broadcasts task:updated for each completed/failed task", async () => {
    const spawn = vi.fn<SpawnFn>(async function* () { yield resultEvent("s"); });
    const dispatcher = createDispatcher({ homePath, spawnFn: spawn });
    const messages: ServerMessage[] = [];

    const provisioner = createProvisioner({
      homePath,
      dispatcher,
      broadcast: (msg) => messages.push(msg),
    });

    writePlan(homePath, makePendingPlan([
      { name: "App 1", description: "One" },
      { name: "App 2", description: "Two" },
    ]));

    await provisioner.onSetupPlanChange();

    const taskUpdated = messages.filter((m) => m.type === "task:updated");
    expect(taskUpdated).toHaveLength(2);
    expect(taskUpdated.every((m) =>
      (m as { type: "task:updated"; status: string }).status === "completed",
    )).toBe(true);
  });
});
