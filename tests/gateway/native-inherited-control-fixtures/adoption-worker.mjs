// Actual Worker execution/exit is observed by its owning Worker object.
// This message is a fixture observation, never native/product identity proof.
import { createRequire } from "node:module";
import { parentPort, workerData, threadId } from "node:worker_threads";
const native = createRequire(import.meta.url)(workerData.addonPath);
let handle, nativeUnavailable = false;
try { handle = native.inheritedControl(); }
catch (error) { nativeUnavailable = error.message === "Terminal native proof unavailable"; }
let cleanupError = false;
if (handle) try { native.close(handle); } catch (error) { cleanupError = true; }
parentPort.postMessage({ event: "worker-attempt", threadId, nativeUnavailable, unexpectedSuccess: !!handle, cleanupError });
parentPort.close();
