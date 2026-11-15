import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Kysely } from "kysely";
import { createChannelManager } from "../../../packages/gateway/src/channels/manager.js";
import { createPushAdapter, type PushAdapter } from "../../../packages/gateway/src/channels/push.js";
import { createCronChannelTrigger } from "../../../packages/gateway/src/cron/channel-trigger.js";
import type { CronJob } from "../../../packages/gateway/src/cron/types.js";
import { createPushTokenStore } from "../../../packages/gateway/src/notifications/push-tokens.js";
import { bootstrapNotificationDatabase, type NotificationDatabase } from "../../../packages/gateway/src/notifications/schema.js";
import { createTestPGlite } from "../../helpers/pglite-test-helper.js";

const scheduledPush: CronJob = {
  id: "cron_daily",
  name: "daily-summary",
  message: "Your daily summary is ready.",
  schedule: { type: "once", at: "2026-11-15T08:00:00.000Z" },
  target: { channel: "push", chatId: "daily-summary" },
  createdAt: "2026-11-14T08:00:00.000Z",
};

describe("scheduled messages sent to a channel", () => {
  let db: Kysely<NotificationDatabase>;
  let push: PushAdapter;

  beforeEach(async () => {
    const pglite = await createTestPGlite();
    db = new Kysely<NotificationDatabase>({ dialect: pglite.dialect });
    await bootstrapNotificationDatabase(db);
  });

  afterEach(async () => {
    push.dispose();
    vi.restoreAllMocks();
    await db.destroy();
  });

  function scheduledSend(computerOwnerId: string | undefined, logBestEffortFailure = vi.fn()) {
    push = createPushAdapter({ tokens: createPushTokenStore(db), ownerId: computerOwnerId });
    const channelManager = createChannelManager({ config: {}, adapters: { push } });
    return { trigger: createCronChannelTrigger({ channelManager, logBestEffortFailure }), logBestEffortFailure };
  }

  it("pushes a scheduled message only to the computer owner's phones, not to other principals' phones", async () => {
    const { trigger } = scheduledSend("owner_a");
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    await push.registerToken("ExponentPushToken[collaborator]", "ios", "owner_b");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      JSON.stringify({ data: [{ status: "ok" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    await trigger(scheduledPush);

    const sent = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string) as Array<{ to: string; body: string }>;
    expect(sent).toEqual([expect.objectContaining({ to: "ExponentPushToken[owner-a]", body: "Your daily summary is ready." })]);
  });

  it("logs a scheduled send that fails instead of leaving the rejection unhandled", async () => {
    const { trigger, logBestEffortFailure } = scheduledSend("owner_a");
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    const failure = new Error("Expo unreachable");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);

    await expect(trigger(scheduledPush)).resolves.toBeUndefined();

    expect(logBestEffortFailure).toHaveBeenCalledWith("Scheduled message to push failed", failure);
  });

  it("sends nothing for a job without a channel target", async () => {
    const { trigger } = scheduledSend("owner_a");
    await push.registerToken("ExponentPushToken[owner-a]", "ios", "owner_a");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await trigger({ ...scheduledPush, target: undefined });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
