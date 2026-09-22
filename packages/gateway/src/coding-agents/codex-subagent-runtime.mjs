import { createCodexSubagentActivity } from "./codex-subagent-activity.mjs";

/** Coordinates bounded child projection and display-only metadata hydration for one runner. */
export function createCodexSubagentRuntime({ persist, progress, warn }) {
  const activity = createCodexSubagentActivity();
  const metadataQueue = [];
  const queuedMetadata = new Set();
  let generation = 0;

  function absorbMetadataRequests() {
    for (const id of activity.takeMetadataRequests()) {
      if (queuedMetadata.has(id)) continue;
      queuedMetadata.add(id);
      metadataQueue.push(id);
    }
  }

  async function persistActivities(activities) {
    for (const projected of activities) {
      await persist(projected);
      progress(projected.activityId);
    }
  }

  function dispatchMetadata({ availableRequests, parent, turn, request }) {
    if (!parent || !turn) return;
    const dispatchGeneration = generation;
    while (metadataQueue.length > 0 && availableRequests() > 0) {
      const id = metadataQueue.shift();
      queuedMetadata.delete(id);
      let capacityRejected = false;
      void request("thread/read", { threadId: id, includeTurns: false }, 5_000,
        { id, parent, turn }).catch((error) => {
        capacityRejected = error instanceof Error && error.message === "provider_request_limit";
        if (capacityRejected && generation === dispatchGeneration && !queuedMetadata.has(id)) {
          queuedMetadata.add(id);
          metadataQueue.unshift(id);
        }
        warn(error);
      }).finally(() => {
        if (!capacityRejected && generation === dispatchGeneration) {
          dispatchMetadata({ availableRequests, parent, turn, request });
        }
      });
    }
  }

  return {
    reset() {
      generation += 1;
      activity.reset();
      metadataQueue.length = 0;
      queuedMetadata.clear();
    },
    async project(raw, parent, turn) {
      await persistActivities(activity.project(raw, parent, turn));
      absorbMetadataRequests();
    },
    async projectMetadata(metadata, thread) {
      await persistActivities(activity.projectMetadata(metadata.id, thread, metadata.parent, metadata.turn));
      absorbMetadataRequests();
    },
    dispatchMetadata,
    isChildMessage(raw, parent) {
      return typeof raw?.params?.threadId === "string" && raw.params.threadId !== parent;
    },
  };
}
