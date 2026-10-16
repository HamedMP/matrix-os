/**
 * Connector sources public API: the table bootstrap, the four kind handlers and the shared sync runner (which lives
 * in ../core/ and is re-exported here).
 */
export { bootstrapBrainConnectorDatabase } from "./database.js";
export {
  createBrainGoogleCalendarHandler, createBrainGoogleDriveHandler, createBrainLinearHandler, createBrainSlackBridgeHandler,
} from "./handlers.js";
export { runBrainSourceSync } from "../core/runner.js";
export {
  BRAIN_CONNECTOR_KINDS, BRAIN_CONNECTOR_LIMITS, type BrainConnectorHandlerDeps, type BrainConnectorKind,
  type BrainSlackBridgeHandlerDeps, type BrainSlackCaptureDocument, type BrainSlackCaptureOutcome,
  type BrainSlackCaptureReader,
} from "./types.js";
