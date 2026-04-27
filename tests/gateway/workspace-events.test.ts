import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceEventStore } from "../../packages/gateway/src/workspace-events.js";

describe("workspace-events", () => {
  let homePath: string;

  beforeEach(async () => {
    homePath = await mkdtemp(join(tmpdir(), "matrix-workspace-events-"));
  });

  afterEach(() => {
    rmSync(homePath, { recursive: true, force: true });
  });

  it("persists bounded activity events with oldest-first eviction and cursor pagination", async () => {
    const store = createWorkspaceEventStore({
      homePath,
      maxEvents: 3,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    const first = await store.publishEvent({ type: "task.created", scope: { projectSlug: "repo" }, payload: { title: "One" } });
    await store.publishEvent({ type: "task.updated", scope: { projectSlug: "repo", taskId: "task_2" }, payload: { status: "running" } });
    const third = await store.publishEvent({ type: "preview.detected", scope: { projectSlug: "repo" }, payload: { url: "http://localhost:3000" } });
    const fourth = await store.publishEvent({ type: "review.updated", scope: { reviewId: "rev_abc123" }, payload: { status: "reviewing" } });

    expect(first.ok).toBe(true);
    expect(fourth.ok).toBe(true);
    await expect(store.listEvents({ limit: 10 })).resolves.toMatchObject({
      ok: true,
      events: [
        expect.objectContaining({ type: "task.updated" }),
        expect.objectContaining({ type: "preview.detected" }),
        expect.objectContaining({ type: "review.updated" }),
      ],
      nextCursor: null,
    });
    if (!third.ok) return;
    await expect(store.listEvents({ cursor: third.event.id, limit: 1 })).resolves.toMatchObject({
      ok: true,
      events: [expect.objectContaining({ type: "review.updated" })],
      nextCursor: null,
    });
  });

  it("validates scopes and list queries without creating unbounded state", async () => {
    const store = createWorkspaceEventStore({ homePath });

    await expect(store.publishEvent({ type: "bad", scope: { projectSlug: "../bad" }, payload: {} })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_event_scope" },
    });
    await expect(store.listEvents({ limit: 101 })).resolves.toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_event_query" },
    });
  });

  it("serializes concurrent event publishes without dropping activity", async () => {
    const store = createWorkspaceEventStore({
      homePath,
      maxEvents: 100,
      now: () => "2026-04-26T00:00:00.000Z",
    });

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.publishEvent({
      type: `task.event.${index}`,
      scope: { projectSlug: "repo" },
      payload: { index },
    })));

    const listed = await store.listEvents({ projectSlug: "repo", limit: 100 });
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.events).toHaveLength(25);
    expect(new Set(listed.events.map((event) => event.type)).size).toBe(25);
  });
});
