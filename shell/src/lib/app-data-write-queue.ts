export type BridgeDataAction = "read" | "write";

export type BridgeDataRequest = (
  action: BridgeDataAction,
  app: string,
  key: string,
  value: string | undefined,
) => Promise<unknown>;

/**
 * Keep writes from one AppViewer ordered after the iframe posts them. The
 * queue belongs to the parent shell, so already-posted edits continue saving
 * even when closing the app destroys its child document.
 */
export function createSerializedBridgeDataHandler(request: BridgeDataRequest): BridgeDataRequest {
  let writeTail: Promise<unknown> = Promise.resolve();

  return (action, app, key, value) => {
    if (action === "write") {
      const result = writeTail.then(
        () => request(action, app, key, value),
        () => request(action, app, key, value),
      );
      writeTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    return writeTail.then(() => request(action, app, key, value));
  };
}
